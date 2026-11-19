// OptChat memory as a separate, opt-in plugin over DSH's public hooks and DS Bot's
// botSessionIdentity service:
// - session/event: append-origin messages of an opted-in Bot go to its own transcript.
// - a background summarizer (ctx.llm.stream, no tools) builds the summary tree.
// - agent/pre-step: an old, fully covered span of the surface is replaced by the
//   summary view, with a positional `replace` that cites every node it shadows.
// - optchat_search / optchat_zoom read the transcript of the calling Bot only.
// A Session whose owner is unknown or conflicting is never written to a namespace.
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULTS, capResult, closeNamespace, openNamespace, utf8 } from './core.js'
import { buildAll, llmSummarizer } from './summarize.js'

export const HISTORY_KIND = 'optchat-history'
const CONVERSATION = new Set(['user/message', 'assistant/message', 'tool/result'])
const PENDING_PER_SESSION = 200
const PENDING_SESSIONS = 64
const BOT_ID = /^[A-Za-z0-9_-]{1,128}$/
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

const textOf = content => (content ?? []).map(block => {
  if (block?.type === 'text') return block.text
  if (block?.type === 'image') return '[image]'
  return ''
}).filter(Boolean).join('\n')

/** The transcript records one surface event yields, in order. */
export function recordsOf(event) {
  if (event.surfaceOp !== 'append' || !CONVERSATION.has(event.type)) return []
  if (event.type === 'user/message') {
    const kind = event.data?.source?.kind
    if (kind === HISTORY_KIND) return []
    const text = textOf(event.data.content)
    return text === '' ? [] : [{ kind: kind === 'user' ? 'user' : 'note', text, metadata: { source_kind: String(kind ?? '') } }]
  }
  if (event.type === 'assistant/message') {
    if (event.data.interrupted === true && textOf(event.data.message.content) === '') return []
    const records = []
    for (const block of event.data.message.content ?? []) {
      if (block.type === 'text' && block.text.trim() !== '') records.push({ kind: 'talk', text: block.text, metadata: {} })
      if (block.type === 'tool-call') records.push({ kind: 'tool', text: `${block.name} ${block.arguments}`, metadata: { tool_call_id: String(block.id), tool_name: block.name } })
    }
    return records
  }
  const message = event.data.message
  return [{ kind: 'echo', text: capResult(textOf(message.content)), metadata: { tool_call_id: String(message.toolCallId), ...(message.isError ? { is_error: 'true' } : {}) } }]
}

export function install(ctx, config, { identity, llm = ctx.llm, warn = (...args) => ctx.logger?.warn?.(...args) } = {}) {
  if (typeof config?.root !== 'string' || config.root === '') throw new Error('optchat: config.root is required')
  if (identity === undefined) throw new Error('optchat: the botSessionIdentity service is required')
  const settings = { ...DEFAULTS, ...config.limits }
  const bots = config.bots ?? {}
  const optedIn = botId => typeof botId === 'string' && BOT_ID.test(botId) && Object.hasOwn(bots, botId) && bots[botId] !== false
  const spaces = new Map()
  const seqMax = new Map()
  const pending = new Map()
  const jobs = new Map()
  const timers = new Set()
  const errors = new Map()
  const stop = new AbortController()

  function space(botId) {
    let ns = spaces.get(botId)
    if (ns !== undefined) return ns
    ns = openNamespace(join(config.root, botId), { warn })
    const index = new Map()
    for (const event of ns.events) {
      const { session_id: sid, seq } = event.metadata
      if (sid !== undefined && seq !== undefined) index.set(`${sid}:${seq}`, Math.max(index.get(`${sid}:${seq}`) ?? -1, event.i))
    }
    spaces.set(botId, ns)
    seqMax.set(botId, index)
    return ns
  }

  // An authorization decision is never cached: each event re-reads its owner.
  function ownerOf(sessionId) {
    const owner = identity.ownerOfSession(sessionId)
    return owner !== undefined && optedIn(owner.botId) ? owner : owner === undefined ? undefined : null
  }

  function write(owner, sessionId, event) {
    const ns = space(owner.botId)
    const index = seqMax.get(owner.botId)
    let added = false
    recordsOf(event).forEach((record, n) => {
      const metadata = { ...record.metadata, session_id: sessionId, seq: String(event.seq), ...(owner.roomId === undefined ? {} : { room_id: owner.roomId }) }
      const result = ns.append(record.kind, record.text, { metadata, date: new Date(event.time).toISOString(), key: `${sessionId}:${event.seq}#${n}` })
      index.set(`${sessionId}:${event.seq}`, Math.max(index.get(`${sessionId}:${event.seq}`) ?? -1, result.event.i))
      added ||= result.added
    })
    if (added) kick(owner.botId)
  }

  function capture(sessionId, event) {
    if (recordsOf(event).length === 0) return
    const owner = ownerOf(sessionId)
    if (owner === null) return
    if (owner === undefined) {
      // Ownership may be indexed just after the first events of a new Session: hold them
      // until the identity service says what changed, and write them only then.
      let held = pending.get(sessionId)
      if (held === undefined) {
        if (pending.size >= PENDING_SESSIONS) pending.delete(pending.keys().next().value)
        pending.set(sessionId, held = [])
      }
      if (held.length < PENDING_PER_SESSION) held.push(event)
      return
    }
    flush(sessionId, owner)
    write(owner, sessionId, event)
  }

  function flush(sessionId, owner = ownerOf(sessionId)) {
    const held = pending.get(sessionId)
    if (held === undefined || owner === undefined) return
    pending.delete(sessionId)
    if (owner === null) return
    for (const event of held) write(owner, sessionId, event)
  }

  function summarizerFor(botId) {
    const route = bots[botId]?.route ?? config.route
    if (route?.provider === undefined || route?.model === undefined || llm === undefined) return undefined
    return llmSummarizer(llm, route)
  }

  function kick(botId) {
    const summarize = summarizerFor(botId)
    if (summarize === undefined || stop.signal.aborted) return
    const running = jobs.get(botId)
    if (running !== undefined) { running.again = true; return }
    const job = { again: false }
    jobs.set(botId, job)
    job.promise = (async () => {
      try {
        do {
          job.again = false
          await buildAll(space(botId), summarize, { nodeBytes: settings.nodeBytes, attempts: settings.sizeAttempts, signal: stop.signal })
        } while (job.again && !stop.signal.aborted)
        errors.delete(botId)
      } catch (error) {
        // The transcript is already durable; only the derived node waits for a retry.
        errors.set(botId, error)
        warn('optchat: summary for %s failed, retrying later: %s', botId, error?.message ?? error)
        const timer = setTimeout(() => { timers.delete(timer); kick(botId) }, settings.retryMs)
        timer.unref?.()
        timers.add(timer)
      } finally {
        jobs.delete(botId)
      }
    })()
  }

  /** Replace the oldest covered span of a Session's surface by the summary view. */
  function replaceHistory(agent) {
    const owner = ownerOf(agent.id)
    if (owner === undefined || owner === null) return undefined
    flush(agent.id, owner)
    const session = agent.session
    const ns = space(owner.botId)
    const index = seqMax.get(owner.botId)
    const nodes = session.surface.nodes
    const events = nodes.map(seq => session.eventAt(seq))
    let start = events.findIndex(event => CONVERSATION.has(event?.type))
    if (start < 0) return undefined
    const turnStarts = []
    for (let k = start; k < events.length && CONVERSATION.has(events[k]?.type); k += 1) {
      if (events[k].type === 'user/message' && events[k].data?.source?.kind !== HISTORY_KIND) turnStarts.push(k)
    }
    const keep = turnStarts.length - settings.keepTurns
    if (keep <= 0) return undefined
    // The span ends just before a kept turn starts, so no tool call is cut from its result.
    let end = turnStarts[keep]
    let limit = 0
    for (let k = start; k < end; k += 1) {
      const event = events[k]
      if (event.type === 'user/message' && event.data?.source?.kind === HISTORY_KIND) {
        limit = Math.max(limit, Number(event.data.source.upTo) || 0)
        continue
      }
      const id = index.get(`${agent.id}:${event.seq}`)
      if (id === undefined) { end = k; break }
      limit = Math.max(limit, id + 1)
    }
    while (end > start && events[end - 1].type !== 'tool/result' && events[end]?.type !== 'user/message') end -= 1
    if (end - start < 2) return undefined
    const shadowed = events.slice(start, end)
    const bytes = shadowed.reduce((total, event) => total + utf8(JSON.stringify(session.deriveEventMessage(event)?.content ?? [])), 0)
    if (bytes < settings.replaceAfterBytes) return undefined
    const view = ns.view(limit, settings.viewBytes)
    // Only a view that covers every shadowed message may stand in for it.
    if (view.covered < limit || !view.fits || view.size >= bytes) return undefined
    const text = [
      `[OptChat memory: this Bot's transcript, messages 0-${limit - 1}, oldest first. A line is "id+count|summary"; optchat_zoom(id, count) opens it, optchat_search finds exact words.]`,
      ns.render(view),
    ].join('\n')
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: HISTORY_KIND, upTo: limit } })
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: shadowed[0].seq, endSeq: shadowed.at(-1).seq },
      sourceEventSeqs: shadowed.map(event => event.seq),
    })
    return { start: shadowed[0].seq, end: shadowed.at(-1).seq, limit, bytes, viewBytes: view.size }
  }

  const callerSpace = exec => {
    const owner = ownerOf(exec?.agent?.id)
    if (owner === undefined || owner === null) return undefined
    return space(owner.botId)
  }
  const OFF = 'OptChat memory is not on for this Session.'
  const tools = [
    defineTool({
      name: 'optchat_search',
      description: 'Search your own long-term transcript for messages containing every word, newest first. Returns message IDs to open with optchat_zoom.',
      parameters: {
        query: { type: 'string', required: true, description: 'Words that must all appear' },
        limit: { type: 'number', description: 'Most results, default 10' },
      },
      output,
      async execute(args, exec) {
        const ns = callerSpace(exec)
        if (ns === undefined) return OFF
        const hits = ns.search(args.query, Math.min(50, Math.max(1, Number(args.limit) || 10)))
        if (hits.length === 0) return 'No message has all of those words.'
        return hits.map(hit => `${hit.id} [${hit.date}] ${hit.kind}: ${hit.snippet}`).join('\n')
      },
    }),
    defineTool({
      name: 'optchat_zoom',
      description: 'Open part of your transcript: zoom(id, 1) is the original message with its date; a summary line "id+count" opens into its two halves.',
      parameters: {
        id: { type: 'number', required: true, description: 'First message ID of the range' },
        count: { type: 'number', description: 'Range length, a power of two aligned to id; default 1' },
      },
      output,
      async execute(args, exec) {
        const ns = callerSpace(exec)
        if (ns === undefined) return OFF
        const n = args.count ?? 1
        try {
          const body = ns.zoom(args.id, n)
          return n === 1 ? `${body}\ndate: ${ns.date(args.id)}` : body
        } catch (error) {
          return error.message
        }
      },
    }),
  ]

  ctx.on('session/event', (session, event) => {
    try { capture(session.id, event) } catch (error) { warn('optchat: capture failed for %s: %s', session.id, error?.message ?? error) }
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    if (!payload.signal?.aborted) {
      try { replaceHistory(payload.agent) } catch (error) { warn('optchat: history replacement skipped for %s: %s', payload.agent.id, error?.message ?? error) }
    }
    return next()
  })
  const unsubscribe = identity.subscribe?.(() => { for (const sessionId of [...pending.keys()]) flush(sessionId) })
  const unregister = tools.map(tool => ctx.tools.register(tool))

  async function dispose() {
    stop.abort()
    for (const timer of timers) clearTimeout(timer)
    unsubscribe?.()
    for (const off of unregister) if (typeof off === 'function') off()
    await Promise.allSettled([...jobs.values()].map(job => job.promise))
    for (const botId of spaces.keys()) closeNamespace(join(config.root, botId))
    spaces.clear()
  }

  return {
    space,
    replaceHistory,
    errors,
    pending,
    dispose,
    async idle() {
      while (jobs.size > 0) await Promise.allSettled([...jobs.values()].map(job => job.promise))
    },
  }
}
