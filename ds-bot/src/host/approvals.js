import { randomUUID } from 'node:crypto'
import { isAbsolute, sep } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { cleanText } from './diagnostics.js'
import { REFERENCE_KIND, REPLY_KIND } from './constants.js'
import { reviewApproval, reviewContext, reviewSessionIds, REVIEW_TIMEOUT_MS } from './approval-review.js'

const OUTCOMES = { allow: 'allowed-once', reject: 'rejected' }
const sessionOf = agent => agent?.session?.id ?? agent?.id
const keyOf = (agent, callId) => JSON.stringify([sessionOf(agent), callId])

async function nativeEvidence(ctx, exec) {
  const evidence = { kind: 'tool', tool: exec.name, arguments: JSON.parse(JSON.stringify(exec.arguments ?? {})) }
  if (!['bash', 'pwsh'].includes(exec.name) || !exec.agent?.session) return evidence
  const directories = ctx.get?.('workingDirectory')
  const shell = ctx.get?.('shell')
  const fs = ctx.get?.('fs')
  if (!directories?.ensure || !shell?.resolve || !fs?.resolve || !fs?.processPath || !fs?.stat) return evidence
  const sessionCwd = await directories.ensure(exec.agent, exec.signal)
  if (typeof sessionCwd !== 'string' || !isAbsolute(sessionCwd)) return evidence
  const args = evidence.arguments
  if (args.workdir !== undefined && typeof args.workdir !== 'string') return evidence
  // Match the native tools' relative override, then let the execution backend resolve it.
  const workdir = args.workdir === undefined ? sessionCwd : isAbsolute(args.workdir) ? args.workdir : `${sessionCwd}${sep}${args.workdir}`
  const spec = shell.resolve({ command: args.command, workdir })
  if (typeof spec.workdir !== 'string' || !isAbsolute(spec.workdir)) return evidence
  const target = await fs.resolve(spec.workdir, { signal: exec.signal })
  if ((await fs.stat(target, exec.signal))?.type !== 'directory') return evidence
  const cwd = fs.processPath(target)
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return evidence
  return { ...evidence, sessionCwd, workdir: spec.workdir, cwd }
}

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
  const view = ({ answer, cancelReview, ownerSessionId, lineageSessionIds, ...entry }) => ({ ...entry, answerable: answer !== undefined })
  const changed = entry => emit('updated', view(entry))

  // Queued user input is not a user/message until the pending tool yields.
  ctx.on('session/event', (session, event) => {
    const input = event.type === 'agent/inbox/spliced' && event.data?.inserted?.some(message => ['user', REFERENCE_KIND, REPLY_KIND].includes(message.source?.kind))
    if (!input && event.type !== 'working-directory/change') return
    for (const entry of pending.values()) {
      if (reviewSessionIds(rt, entry).includes(session.id)) entry.cancelReview()
    }
  })

  // Capture immutable tool arguments before any pre-execute policy asks. Result
  // events release both successful and rejected calls, including PTC sub-calls.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const owner = await ownerOf(exec.agent)
    if (!owner || !enabled(owner)) return next()
    if (exec.callId !== undefined) {
      const key = keyOf(exec.agent, exec.callId)
      const readEvidence = () => nativeEvidence(ctx, exec)
      const evidence = await readEvidence().catch(() => ({ kind: 'tool', tool: exec.name }))
      executions.set(key, { evidence, readEvidence })
      if (executions.size > 1000) executions.delete(executions.keys().next().value)
    }
    return next()
  }, { prepend: true })
  ctx.on('tools/result', exec => {
    executions.delete(keyOf(exec.agent, exec.callId))
    if (exec.name === 'ask_user_question') {
      for (const entry of pending.values()) if (reviewSessionIds(rt, entry).includes(sessionOf(exec.agent))) entry.cancelReview()
    }
  })

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
      if (id === undefined || seen.has(id)) break
      seen.add(id)
      const group = rt.groupOwners.get(id)
      const botId = group?.botId ?? rt.chatOwners.get(id)
      if (botId !== undefined) return { sessionId, ownerSessionId: id, lineageSessionIds: [...seen], botId, ...(group ? { roomId: group.roomId } : {}) }
      const parent = current.session?.header?.parentSession
      if (!parent || current.session.header.origin !== 'subagent') break
      current = await rt.resolveAgent(parent).catch(() => undefined)
      if (sessionOf(current) !== parent) break
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
      ? { sessionId, ownerSessionId: sessionId, lineageSessionIds: [sessionId], botId, ...(group ? { roomId: group.roomId } : {}) }
      : await ownerOf(request.agent)
    if (!owner) return next()
    if (request.signal?.aborted) return 'cancelled'
    const captured = executions.get(keyOf(request.agent, request.callId))
    const execution = captured?.evidence.tool === request.toolName ? captured.evidence : undefined
    const nativeShell = ['bash', 'pwsh'].includes(request.toolName)
    // Privacy guards can ask before the shell itself; their payload still needs its execution scope.
    const evidence = explicit && nativeShell ? { ...explicit, execution } : explicit ?? execution
    const validateEvidence = execution && nativeShell ? async () => {
      if (JSON.stringify(await captured.readEvidence()) !== JSON.stringify(execution)) throw new Error('The native execution directory or arguments changed')
    } : undefined
    const id = randomUUID()
    const original = request.signal
    const linked = new AbortController()
    const reviewer = new AbortController()
    const entry = {
      id, sessionId: owner.sessionId, ownerSessionId: owner.ownerSessionId, lineageSessionIds: owner.lineageSessionIds, botId: owner.botId,
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
        request, owner, evidence, validateEvidence, signal: reviewer.signal,
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
        await validateEvidence?.()
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
      if (entry.lineageSessionIds.includes(sessionId)) entry.answer('cancelled')
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
