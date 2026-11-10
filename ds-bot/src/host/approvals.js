import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { cleanText } from './diagnostics.js'
import { REFERENCE_KIND } from './constants.js'
import { reviewApproval, reviewContext, reviewSessionIds, REVIEW_TIMEOUT_MS } from './approval-review.js'

const OUTCOMES = { allow: 'allowed-once', reject: 'rejected' }
const sessionOf = agent => agent?.session?.id ?? agent?.id
const keyOf = (agent, callId) => JSON.stringify([sessionOf(agent), callId])

export function install(rt) {
  const { ctx } = rt
  const pending = new Map()
  const executions = new Map()
  const actionScope = new AsyncLocalStorage()
  const approvalListeners = new Set()
  const clean = text => cleanText(text, { redact: rt.redactSecrets }).slice(0, 1000)
  const emit = (kind, data) => {
    for (const listener of approvalListeners) {
      try { listener(kind, data) } catch (error) { rt.warn('ds-bot: approval listener failed: %s', error) }
    }
  }
  const view = ({ answer, cancelReview, ownerSessionId, ...entry }) => ({ ...entry, answerable: answer !== undefined })
  const changed = entry => emit('updated', view(entry))

  // Queued user input is not a user/message until the pending tool yields.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'agent/inbox/spliced' || !event.data?.inserted?.some(message => ['user', REFERENCE_KIND].includes(message.source?.kind))) return
    for (const entry of pending.values()) {
      if (reviewSessionIds(rt, entry).includes(session.id)) entry.cancelReview()
    }
  })

  // Capture immutable tool arguments before any pre-execute policy asks. Result
  // events release both successful and rejected calls, including PTC sub-calls.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.callId !== undefined) {
      const key = keyOf(exec.agent, exec.callId)
      executions.set(key, { tool: exec.name, arguments: exec.arguments })
      if (executions.size > 1000) executions.delete(executions.keys().next().value)
    }
    return next()
  }, { prepend: true })
  ctx.on('tools/result', exec => { executions.delete(keyOf(exec.agent, exec.callId)) })

  // Async-local evidence belongs to one request, even when a script makes several
  // concurrent requests with the same outer call id. The host API stays unchanged.
  const requestActionApproval = (request, evidence) => actionScope.run(evidence,
    () => ctx.get('approval').request(request))

  async function ownerOf(agent) {
    const sessionId = sessionOf(agent)
    let current = agent
    const seen = new Set()
    while (current && seen.size < 16) {
      const id = sessionOf(current)
      if (seen.has(id)) break
      seen.add(id)
      const group = rt.groupOwners.get(id)
      const botId = group?.botId ?? rt.chatOwners.get(id)
      if (botId !== undefined) return { sessionId, ownerSessionId: id, botId, ...(group ? { roomId: group.roomId } : {}) }
      const parent = current.session?.header?.parentSession
      if (!parent || current.session.header.origin !== 'subagent') break
      current = await rt.resolveAgent(parent).catch(() => undefined)
    }
    return undefined
  }
  const enabled = owner => (rt.roomOf(owner.roomId)?.permission ?? rt.botOf(owner.botId)?.permission) === 'review'

  async function record(entry, decision) {
    const item = {
      id: entry.id, botId: entry.botId, ...(entry.roomId ? { roomId: entry.roomId } : {}),
      tool: entry.tool, at: Date.now(), outcome: decision.decision, reason: clean(decision.reason),
      ...(entry.review?.model ? { model: entry.review.model } : {}),
    }
    rt.state.approvalReviews = [...(rt.state.approvalReviews ?? []).filter(previous => previous.id !== item.id), item].slice(-100)
    await rt.save()
  }

  ctx.on('approval/request', async (request, next) => {
    const explicit = actionScope.getStore()
    const sessionId = sessionOf(request.agent)
    const group = rt.groupOwners.get(sessionId)
    const botId = group?.botId ?? rt.chatOwners.get(sessionId)
    const owner = botId !== undefined
      ? { sessionId, ownerSessionId: sessionId, botId, ...(group ? { roomId: group.roomId } : {}) }
      : await ownerOf(request.agent)
    if (!owner) return next()
    if (request.signal?.aborted) return 'cancelled'
    const captured = executions.get(keyOf(request.agent, request.callId))
    const evidence = explicit ?? (captured?.tool === request.toolName ? { kind: 'tool', ...captured } : undefined)
    const id = randomUUID()
    const original = request.signal
    const linked = new AbortController()
    const reviewer = new AbortController()
    const entry = {
      id, sessionId: owner.sessionId, ownerSessionId: owner.ownerSessionId, botId: owner.botId,
      ...(owner.roomId ? { roomId: owner.roomId } : {}),
      tool: String(request.toolName ?? ''), reason: String(request.reason ?? '').slice(0, 500),
      detail: rt.callDetail?.(owner.sessionId, request.callId) ?? {}, at: Date.now(),
    }
    const automatic = enabled(owner)
    if (automatic) entry.review = { status: 'reviewing' }
    return new Promise((resolve, reject) => {
      let manualStarted = false
      let timer
      const abort = () => complete('cancelled')
      const settle = (outcome, reviewed = false) => {
        if (!pending.has(id)) return false
        pending.delete(id)
        const logged = rt.state?.approvalReviews?.find(item => item.id === id)
        if (!reviewed && logged && ['allow', 'reject'].includes(logged.outcome)) {
          logged.outcome = 'cancelled'
          logged.reason = 'The model decision was withdrawn before it took effect.'
          void rt.save().catch(() => {})
        }
        clearTimeout(timer)
        original?.removeEventListener('abort', abort)
        reviewer.abort()
        linked.abort()
        if (request.signal === linked.signal) request.signal = original
        rt.noteApproval?.(owner.ownerSessionId, undefined)
        emit('settled', { id, outcome })
        return true
      }
      const complete = (outcome, reviewed = false) => { if (settle(outcome, reviewed)) resolve(outcome) }
      const manual = reason => {
        if (!pending.has(id) || manualStarted) return
        manualStarted = true
        clearTimeout(timer)
        if (automatic) entry.review = { ...entry.review, status: 'manual', reason: clean(reason) }
        changed(entry)
        rt.yieldRoomTurn?.(owner.ownerSessionId)
        // Group sessions have DS Bot's member card. Own-chat children still need
        // the host path, since their Bot may have no group approval controls.
        if (owner.roomId !== undefined) return
        request.signal = linked.signal
        Promise.resolve().then(next).then(outcome => {
          if (outcome !== 'unavailable' || owner.ownerSessionId !== owner.sessionId) complete(outcome)
        }, error => { if (settle('cancelled')) reject(error) })
      }
      entry.answer = complete
      entry.cancelReview = () => reviewer.abort()
      pending.set(id, entry)
      rt.noteApproval?.(owner.ownerSessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200) })
      original?.addEventListener('abort', abort, { once: true })
      emit('open', view(entry))
      if (original?.aborted) return complete('cancelled')
      if (!automatic) return manual()
      const timeout = new Promise((_, fail) => {
        const interrupted = () => fail(new Error('Automatic review stopped; review this action manually'))
        reviewer.signal.addEventListener('abort', interrupted, { once: true })
        timer = setTimeout(() => reviewer.abort(), REVIEW_TIMEOUT_MS)
      })
      void Promise.race([reviewApproval(rt, {
        request, owner, evidence, signal: reviewer.signal,
        onModel: model => { if (pending.has(id)) { entry.review.model = model; changed(entry) } },
      }), timeout]).then(async decision => {
        if (!pending.has(id)) return
        if (reviewer.signal.aborted || !enabled(owner)) throw new Error('Automatic review was invalidated')
        if (decision.decision === 'manual') {
          manual(decision.reason)
          await record(entry, decision)
          return
        }
        await record(entry, decision)
        if (JSON.stringify(await reviewContext(rt, owner, reviewer.signal)) !== JSON.stringify(decision.context)) {
          throw new Error('The conversation changed while saving the review')
        }
        if (!pending.has(id)) return
        if (reviewer.signal.aborted || !enabled(owner)) throw new Error('Automatic review was invalidated')
        complete(OUTCOMES[decision.decision], true)
      }).catch(async () => {
        if (!pending.has(id)) return
        const reason = 'Automatic review could not decide. Review this action manually.'
        manual(reason)
        try { await record(entry, { decision: 'manual', reason }) } catch { /* the manual card remains available */ }
      }).finally(() => clearTimeout(timer))
    })
  }, { prepend: true })

  const approvalsView = () => [...pending.values()].map(view)
  const approvalReviewsView = () => rt.state.approvalReviews ?? []
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId)
  function answerApproval(id, choice) {
    const entry = pending.get(String(id ?? ''))
    if (!entry?.answer) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    if (!Object.hasOwn(OUTCOMES, choice)) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    entry.answer(OUTCOMES[choice])
  }
  const cancelApprovals = sessionId => {
    for (const entry of pending.values()) {
      if (entry.sessionId === sessionId || entry.ownerSessionId === sessionId) entry.answer('cancelled')
    }
  }
  const cancelApprovalReviews = ({ botId, roomId } = {}) => {
    for (const entry of pending.values()) {
      if (roomId !== undefined ? entry.roomId === roomId && (botId === undefined || entry.botId === botId) : botId === undefined || (entry.botId === botId && entry.roomId === undefined)) entry.cancelReview()
    }
  }
  ctx.effect?.(() => () => {
    for (const entry of pending.values()) entry.answer('cancelled')
    executions.clear()
    actionScope.disable()
  }, 'ds-bot: approval review')
  const onApproval = listener => { approvalListeners.add(listener); return () => approvalListeners.delete(listener) }
  Object.assign(rt, { approvalsView, approvalReviewsView, waitsForApproval, answerApproval, cancelApprovals, cancelApprovalReviews, onApproval, requestActionApproval })
}
