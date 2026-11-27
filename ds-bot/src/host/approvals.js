import { randomUUID } from 'node:crypto'
import { isAbsolute, sep } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { cleanText } from './diagnostics.js'
import { REFERENCE_KIND, REPLY_KIND } from './constants.js'
import { reviewApproval, reviewContext, reviewSessionIds, REVIEW_TIMEOUT_MS } from './approval-review.js'
import { ESCALATION } from './extra-folders.js'

const OUTCOMES = { allow: 'allowed-once', reject: 'rejected' }
const FILE_ESCALATION_TOOLS = new Set(['write', 'edit', 'apply_patch'])
const sessionOf = agent => agent?.session?.id ?? agent?.id
const keyOf = (agent, callId) => JSON.stringify([sessionOf(agent), callId])

function cleanDisplayReason(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const [lang, text] of Object.entries(raw)) {
    if (typeof lang === 'string' && lang.length <= 16 && typeof text === 'string' && text.trim() !== '') {
      out[lang] = text.slice(0, 500)
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

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
  const view = ({ answer, cancelReview, toManual, isAborted, ownerSessionId, lineageSessionIds, prepareAlways, answering, privacy: _, ...entry }) => {
    const taskSessionId = rt.taskOwners?.has(entry.sessionId) ? entry.sessionId : ownerSessionId ?? entry.sessionId
    const liveTask = entry.taskId === undefined ? rt.taskOwners?.get(taskSessionId) : undefined
    const liveEntry = liveTask === undefined ? undefined : rt.taskBySession?.(taskSessionId)?.task
    const liveTitle = entry.taskTitle ?? liveEntry?.title
    const liveRoomId = entry.roomId === undefined ? (liveTask?.roomId ?? liveEntry?.roomId) : undefined
    return {
      ...entry,
      ...(ownerSessionId !== undefined && ownerSessionId !== entry.sessionId ? { ownerSessionId } : {}),
      ...(liveRoomId !== undefined ? { roomId: liveRoomId } : {}),
      ...(liveTask ? { taskId: liveTask.taskId, ...(liveTitle ? { taskTitle: liveTitle } : {}) } : {}),
      answerable: answer !== undefined,
    }
  }
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
    if (!owner) return next()
    if (enabled(owner)) {
      if (exec.callId !== undefined) {
        const key = keyOf(exec.agent, exec.callId)
        const readEvidence = () => nativeEvidence(ctx, exec)
        const evidence = await readEvidence().catch(() => ({ kind: 'tool', tool: exec.name }))
        executions.set(key, { evidence, readEvidence })
        if (executions.size > 1000) executions.delete(executions.keys().next().value)
      }
    } else if (FILE_ESCALATION_TOOLS.has(exec.name) && exec.arguments?.sandbox_permissions !== undefined && exec.callId !== undefined) {
      // Capture only the file-tool arguments needed to evaluate "Always allow" extra-folder eligibility,
      // never touching workingDirectory.ensure when automatic review is off.
      const key = keyOf(exec.agent, exec.callId)
      const evidence = { kind: 'tool', tool: exec.name, arguments: JSON.parse(JSON.stringify(exec.arguments ?? {})) }
      executions.set(key, { evidence })
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

  const ownerAt = (sessionId, id, seen) => {
    const group = rt.groupOwners.get(id)
    const taskOwner = rt.taskOwners?.get(id)
    const botId = group?.botId ?? taskOwner?.botId ?? rt.chatOwners.get(id)
    if (botId === undefined) {
      const agentOwner = rt.agentOf?.(id)
      if (agentOwner === undefined) return undefined
      return { sessionId, ownerSessionId: id, lineageSessionIds: [...seen] }
    }
    const task = taskOwner === undefined ? undefined : rt.taskBySession?.(id)?.task
    const taskTitle = task?.title
    const roomId = group ? group.roomId : (taskOwner?.roomId ?? task?.roomId)
    return {
      sessionId, ownerSessionId: id, lineageSessionIds: [...seen], botId,
      ...(roomId !== undefined ? { roomId } : {}),
      ...(taskOwner ? { taskId: taskOwner.taskId, ...(taskTitle ? { taskTitle } : {}) } : {}),
    }
  }

  async function ownerOf(agent) {
    const sessionId = sessionOf(agent)
    let current = agent
    const seen = new Set()
    while (current && seen.size < 16) {
      const id = sessionOf(current)
      if (id === undefined || seen.has(id)) break
      seen.add(id)
      const owner = ownerAt(sessionId, id, seen)
      if (owner) return owner
      const parent = current.session?.header?.parentSession
      if (!parent || current.session.header.origin !== 'subagent') break
      current = await rt.resolveAgent(parent).catch(() => undefined)
      if (sessionOf(current) !== parent) break
    }
    return undefined
  }

  // ownerOf only awaits while it walks a subagent's parent chain; a directly owned
  // Session resolves here, so the request's card exists before the listener returns.
  const followParent = {}
  const ownerNow = (agent) => {
    const id = sessionOf(agent)
    if (id === undefined) return undefined
    const owner = ownerAt(id, id, new Set([id]))
    if (owner) return owner
    const parent = agent.session?.header?.parentSession
    if (parent && agent.session.header.origin === 'subagent') return followParent
    return undefined
  }
  const enabled = owner => owner.botId !== undefined && (rt.roomOf(owner.roomId)?.permission ?? rt.botOf(owner.botId)?.permission) === 'review'

  async function record(entry, decision) {
    const item = {
      id: entry.id, botId: entry.botId, ...(entry.roomId ? { roomId: entry.roomId } : {}),
      tool: entry.tool, at: Date.now(), outcome: decision.decision, reason: clean(decision.reason),
      ...(entry.review?.model ? { model: entry.review.model } : {}),
    }
    rt.state.approvalReviews = [...(rt.state.approvalReviews ?? []).filter(previous => previous.id !== item.id), item].slice(-100)
    await rt.save()
  }

  // Ahead of DSH's own answerer, which would hold a hidden Session's request unseen.
  ctx.on('approval/request', (request, next) => {
    const explicit = actionScope.getStore()
    const owner = ownerNow(request.agent)
    if (owner === followParent) return ownerOf(request.agent).then(resolved => handleRequest(request, next, resolved, explicit))
    return handleRequest(request, next, owner, explicit)
  }, { prepend: true })

  function handleRequest(request, next, owner, explicit) {
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
    const displayReason = cleanDisplayReason(request.displayReason)
    const entry = {
      id, sessionId: owner.sessionId, ownerSessionId: owner.ownerSessionId, lineageSessionIds: owner.lineageSessionIds,
      ...(owner.botId !== undefined ? { botId: owner.botId } : {}),
      ...(owner.roomId ? { roomId: owner.roomId } : {}),
      ...(owner.taskId ? { taskId: owner.taskId, ...(owner.taskTitle ? { taskTitle: owner.taskTitle } : {}) } : {}),
      tool: String(request.toolName ?? ''), reason: String(request.reason ?? '').slice(0, 500),
      ...(displayReason ? { displayReason } : {}),
      ...(request.privacy === true ? { privacy: true } : {}),
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
        const settledTaskId = entry.taskId ?? rt.taskOwners?.get(owner.sessionId)?.taskId ?? rt.taskOwners?.get(owner.ownerSessionId)?.taskId
        emit('settled', { id, outcome, ...(settledTaskId ? { taskId: settledTaskId } : {}) })
        return true
      }
      const complete = (outcome, reviewed = false) => {
        const didSettle = settle(outcome, reviewed)
        if (didSettle) resolve(outcome)
        return didSettle
      }
      const manual = reason => {
        if (!pending.has(id) || manualStarted) return
        manualStarted = true
        clearTimeout(timer)
        if (automatic) entry.review = { ...entry.review, status: 'manual', reason: clean(reason) }
        changed(entry)
        // Group sessions and background tasks run in hidden Sessions owned by DS Bot's
        // cards (group member card or task deck), so they never race DSH's own card.
        // Own-chat children still need the host path, since their Bot may have no group
        // approval controls.
        const yieldSession = owner.taskId === undefined || owner.roomId === undefined
          ? owner.ownerSessionId
          : rt.roomOf(owner.roomId)?.sessions?.[owner.botId] ?? owner.ownerSessionId
        rt.yieldRoomTurn?.(yieldSession)
        if (owner.roomId !== undefined || owner.taskId !== undefined) return
        request.signal = linked.signal
        Promise.resolve().then(next).then(outcome => {
          if (outcome !== 'unavailable' || owner.ownerSessionId !== owner.sessionId) complete(outcome)
        }, error => { if (settle('cancelled')) reject(error) })
      }
      entry.answer = complete
      entry.cancelReview = () => reviewer.abort()
      entry.toManual = () => {
        if (automatic && pending.has(id) && entry.review?.status === 'reviewing') {
          manual('Automatic review stopped; review this action manually.')
        }
      }
      entry.isAborted = () => original?.aborted === true
      pending.set(id, entry)
      rt.noteApproval?.(owner.ownerSessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200), ...(entry.privacy ? { privacy: true } : {}) })
      original?.addEventListener('abort', abort, { once: true })
      emit('open', view(entry))
      // "Always allow" is offered only for direct (non-subagent) Bot/group file-tool sandbox
      // escalations (`extraDirs`), where DS Bot has a visible, revocable folder-grant store and
      // matching auto-allow escalation handler. Browser write prompts stay one-time (preauthorization
      // lives in Browser settings); shell commands, privacy gates, private Bots, local agents,
      // classic sessions, and subagent child sessions stay strictly one-time.
      if (owner.botId !== undefined
        && owner.sessionId === owner.ownerSessionId
        && request.privacy !== true
        && !explicit
        && !entry.alwaysAllow
        && FILE_ESCALATION_TOOLS.has(entry.tool)
        && entry.reason.startsWith(ESCALATION)
        && execution?.arguments
        && typeof rt.resolvableExtraDirs === 'function') {
        void rt.resolvableExtraDirs({
          session: request.agent?.session,
          botId: owner.botId,
          roomId: owner.roomId,
          name: entry.tool,
          args: execution.arguments,
        }).then((dirs) => {
          if (!pending.has(id) || entry.answering || !Array.isArray(dirs) || dirs.length === 0) return
          const scopeRoom = owner.roomId ? rt.roomOf(owner.roomId) : undefined
          const groupScoped = scopeRoom?.workDir !== undefined
          const scope = groupScoped ? 'group' : 'bot'
          entry.alwaysAllow = {
            kind: 'extra-dir',
            dirs,
            scope,
            ...(groupScoped && scopeRoom?.name ? { scopeName: scopeRoom.name } : {}),
          }
          entry.prepareAlways = () => rt.prepareGrantExtraDirs({ botId: owner.botId, roomId: owner.roomId, dirs, scope })
          changed(entry)
        }).catch(() => {})
      }
      if (original?.aborted) return complete('cancelled')
      if (!automatic) return manual()
      const timeout = new Promise((_, fail) => {
        const interrupted = () => fail(new Error('Automatic review stopped; review this action manually'))
        reviewer.signal.addEventListener('abort', interrupted, { once: true })
        // Once the model wins the race, a stalled save no longer rejects it.
        // Open the card from the timer itself so persistence cannot block it.
        timer = setTimeout(() => {
          reviewer.abort()
          if (pending.has(id)) manual('Automatic review could not decide. Review this action manually.')
        }, REVIEW_TIMEOUT_MS)
      })
      void Promise.race([reviewApproval(rt, {
        request, owner, evidence, validateEvidence, signal: reviewer.signal,
        onModel: model => { if (pending.has(id)) { entry.review.model = model; changed(entry) } },
      }), timeout]).then(async decision => {
        if (!pending.has(id) || entry.answering) return
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
        if (!pending.has(id) || entry.answering) return
        if (reviewer.signal.aborted || !enabled(owner)) throw new Error('Automatic review was invalidated')
        complete(OUTCOMES[decision.decision], true)
      }).catch(async () => {
        if (!pending.has(id) || entry.answering) return
        const reason = 'Automatic review could not decide. Review this action manually.'
        manual(reason)
        try { await record(entry, { decision: 'manual', reason }) } catch { /* the manual card remains available */ }
      }).finally(() => clearTimeout(timer))
    })
  }

  const approvalsView = () => [...pending.values()].map(view)
  const approvalById = id => pending.get(String(id ?? ''))
  const approvalReviewsView = () => rt.state.approvalReviews ?? []
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId)
  function answerApproval(id, choice) {
    const entry = pending.get(String(id ?? ''))
    if (!entry?.answer) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    if (choice === 'always') {
      if (!entry.alwaysAllow || typeof entry.prepareAlways !== 'function') {
        throw Object.assign(new Error('Always allow is not available for this request'), { code: 'bot/refused' })
      }
      if (entry.answering) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
      // Two-phase validate -> settle -> commit: reserve the approval and cancel automatic
      // review synchronously while keeping the tool blocked until Phase 1 validation succeeds.
      // If validation fails, release the reservation so the approval stays open and answerable.
      // Only once validation passes and the entry is still live and unaborted do we settle
      // `allowed-once` synchronously and commit the pre-validated grant.
      entry.cancelReview()
      if (entry.isAborted?.()) {
        entry.answer('cancelled')
        throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
      }
      entry.answering = true
      return (async () => {
        let prepared
        try {
          prepared = await entry.prepareAlways()
        } catch (error) {
          if (pending.has(id)) {
            entry.answering = false
            if (entry.isAborted?.()) entry.answer('cancelled')
            else entry.toManual?.()
          }
          throw error
        }
        if (!pending.has(id) || entry.isAborted?.()) {
          if (pending.has(id)) entry.answer('cancelled')
          throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
        }
        if (typeof prepared?.verifySync === 'function' && !prepared.verifySync()) {
          entry.answering = false
          entry.toManual?.()
          throw Object.assign(new Error('Always allow is not available for this request'), { code: 'bot/refused' })
        }
        const settled = entry.answer('allowed-once')
        if (!settled) {
          throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
        }
        return await prepared.commit()
      })()
    }
    if (!Object.hasOwn(OUTCOMES, choice)) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    if (entry.answering) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
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
    for (const entry of Array.from(pending.values())) entry.answer?.('cancelled')
    pending.clear()
    approvalListeners.clear()
    executions.clear()
    actionScope.disable()
  }, 'ds-bot: approval review')
  const onApproval = listener => { approvalListeners.add(listener); return () => approvalListeners.delete(listener) }
  const isPrivacyApproval = id => pending.get(id)?.privacy === true
  Object.assign(rt, { approvalsView, approvalById, approvalReviewsView, waitsForApproval, answerApproval, cancelApprovals, cancelApprovalReviews, onApproval, requestActionApproval, isPrivacyApproval })
}
