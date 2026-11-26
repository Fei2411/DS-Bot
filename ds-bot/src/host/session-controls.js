// Per-session controls, queue management, slash/skill/file discovery, and DSH
// user-questions/plan-review bridging for DS Bot's own desktop window over `/api/bot`.
// The `user-questions/request` bridge prepends like `approvals.js`, but claims a request
// ONLY when running under DS Bot's own desktop app (`DS_BOT_APP=1` / `config.ownWindow`)
// with a local window connected (`rt.hasLocalFeedClient()`). In DSH Web/Desktop plugin
// mode, headless hosts, or when no window is connected, it passes requests through
// untouched so DSH's own providers and `NO_PROVIDER` semantics remain unchanged.
import { randomUUID } from 'node:crypto'
import { serviceOf } from './services.js'
import { splitRef } from './text.js'
import { windowError } from './session-follow.js'

const SESSION_ID = /^[\w-]{1,128}$/
const OWN_QUEUE_KINDS = new Set(['user', 'schedule', 'user-question-reply'])
const CONTROL_EVENTS = new Set([
  'agent/inbox/spliced',
  'plan/mode',
  'command/run',
  'command/done',
  'permission/preset',
  'model/select',
])

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const notFound = message => Object.assign(new Error(message), { code: 'bot/not-found' })
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const stale = message => Object.assign(new Error(message), { code: 'bot/stale' })
const userQuestionError = (message, code) => Object.assign(new Error(message), { name: 'UserQuestionError', code })

function requireSessionId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!SESSION_ID.test(id)) throw invalid('A Session id is required')
  return id
}

function serializeContent(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text })
    } else if ((block.type === 'image' || block.type === 'file') && block.attachment !== undefined) {
      out.push({ type: block.type, attachment: block.attachment })
    }
  }
  return out
}

function serializeSource(source) {
  if (!source || typeof source !== 'object') return { kind: 'unknown' }
  return {
    kind: typeof source.kind === 'string' ? source.kind : 'unknown',
    ...(typeof source.rpcId === 'string' ? { rpcId: source.rpcId } : {}),
    ...(typeof source.callId === 'string' ? { callId: source.callId } : {}),
  }
}

function serializeQueueRows(nextTurn) {
  if (!Array.isArray(nextTurn) || nextTurn.length === 0) return []
  const out = []
  for (const message of nextTurn) {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') continue
    if (!OWN_QUEUE_KINDS.has(message.source?.kind)) continue
    out.push({
      id: message.id,
      content: serializeContent(message.content),
      source: serializeSource(message.source),
    })
  }
  return out
}

function normalizeQuestionItem(item) {
  if (!item || typeof item !== 'object') return null
  const id = typeof item.id === 'string' ? item.id : ''
  const question = typeof item.question === 'string' ? item.question : ''
  if (id === '' || question === '') return null
  const options = Array.isArray(item.options)
    ? item.options
      .filter(opt => opt && typeof opt.label === 'string')
      .map(opt => ({
        label: opt.label,
        ...(typeof opt.description === 'string' && opt.description !== '' ? { description: opt.description } : {}),
      }))
    : undefined
  const intent = item.intent && typeof item.intent === 'object' ? { ...item.intent } : undefined
  return {
    id,
    question,
    ...(typeof item.header === 'string' && item.header !== '' ? { header: item.header } : {}),
    ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
    ...(options !== undefined && options.length > 0 ? { options } : {}),
    ...(item.multiSelect === true ? { multiSelect: true } : {}),
    ...(intent !== undefined ? { intent } : {}),
  }
}

function kindOfQuestions(questions) {
  return questions.length === 1 && questions[0]?.intent?.kind === 'plan-review' ? 'plan-review' : 'question'
}

function normalizeAnswers(rawAnswers, questions) {
  if (!Array.isArray(rawAnswers)) throw invalid('Answers must be a list')
  const expected = new Set(questions.map(item => item.id))
  const seen = new Set()
  const out = []
  for (const item of rawAnswers) {
    if (!item || typeof item !== 'object') throw invalid('Invalid answer item')
    const id = typeof item.id === 'string' ? item.id : ''
    if (!expected.has(id) || seen.has(id)) throw invalid('Answers must match each question once')
    seen.add(id)
    const selected = Array.isArray(item.selected) ? item.selected.map(String) : []
    const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
    out.push({
      id,
      selected,
      ...(custom !== '' ? { custom } : {}),
    })
  }
  if (seen.size !== expected.size) throw invalid('Answers must match each question once')
  return out
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, { id: string, sessionId: string, callId?: string, kind: 'question' | 'plan-review', timed: boolean, deadlineAt?: number, questions: object[], at: number, resolve: (value: object) => void, reject: (error: Error) => void, releaseWindow: () => void }>} */
  const pendingQuestions = new Map()
  // Persisted `continued` questions observed on cold sessions (via `readControls`),
  // cleared as soon as the session wakes or its projection settles them.
  /** @type {Map<string, object[]>} */
  const observedColdQuestions = new Map()

  const notify = () => { rt.notifyLive?.() }

  const isOwnedClassic = sessionId => rt.agentOf?.(sessionId) !== undefined
  const isForegroundBotSession = (sessionId) => {
    const botId = rt.chatOwners?.get?.(sessionId)
    return botId !== undefined
      && (typeof rt.chatOf !== 'function' || rt.chatOf(botId) === sessionId)
      && !rt.groupOwners?.has?.(sessionId)
      && !rt.taskOwners?.has?.(sessionId)
      && !rt.pastOwners?.has?.(sessionId)
  }
  // Only Classic Agent sessions and active foreground Bot chats render `ClassicQuestionDock`
  // / `ClassicPlanReviewDock` in `app/ui/src/chat.js`. Group rooms, group member sessions,
  // background tasks, and retired past segments have no dock and must pass through to `next()`.
  const isDrawableQuestionSession = sessionId => isOwnedClassic(sessionId) || isForegroundBotSession(sessionId)
  const isOwnedSession = sessionId => isOwnedClassic(sessionId)
    || rt.selfOf?.(sessionId) !== undefined
    || rt.chatOwners?.has?.(sessionId) === true
    || rt.roomOf?.(sessionId) !== undefined
    || rt.botOf?.(sessionId) !== undefined

  const isDesktopApp = () => rt.config?.ownWindow === true || process.env.DS_BOT_APP === '1'
  const ownWindowActive = () => isDesktopApp() && rt.hasLocalFeedClient?.() === true

  const writeCheck = () => {
    const reason = rt.readOnly?.()
    if (reason !== undefined) throw Object.assign(new Error(reason), { code: 'bot/read-only' })
  }

  // Answerer bridge for DSH `user-questions/request` (`ask_user_question` and `exit_plan_mode`
  // plan review). Claims a request ONLY when DS Bot's own desktop window is running and
  // connected to this Host and the target session can render a question dock; in DSH Web/Desktop
  // plugin mode, headless DSH, non-drawable sessions (groups/tasks/past segments), or with no
  // window connected, passes through to `next()` untouched (preserving `NO_PROVIDER`).
  ctx.on?.('user-questions/request', async (request, next) => {
    const rawQuestions = Array.isArray(request?.questions) ? request.questions : []
    // Leave computer-use consent (`cua-*`) and approval-intent questions to `computer/index.js` and DSH.
    if (rawQuestions.some(q => q?.id?.startsWith?.('cua-') || q?.intent?.kind === 'approval')) {
      return await next()
    }
    if (!ownWindowActive()) return await next()
    const agent = request?.agent
    const sessionId = agent?.session?.id ?? agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return await next()
    await rt.load()
    if (!isDrawableQuestionSession(sessionId)) return await next()
    if (!ownWindowActive()) return await next()
    if (request.signal?.aborted) {
      throw userQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    }
    const questions = rawQuestions.map(normalizeQuestionItem).filter(Boolean)
    if (questions.length === 0) {
      throw userQuestionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS')
    }
    const id = randomUUID()
    const callId = request.wait?.callId ?? questions[0]?.intent?.callId
    const isTimed = request.wait?.timed === true && typeof request.wait?.callId === 'string' && request.wait.callId !== ''
    const original = request.signal
    const linked = new AbortController()
    let waitAbort
    let windowAttached = false
    return await new Promise((resolve, reject) => {
      let settled = false
      let waitTimer
      const cleanup = () => {
        clearTimeout(waitTimer)
        waitTimer = undefined
        original?.removeEventListener?.('abort', onAbort)
        if (request.signal === linked.signal) request.signal = original
        waitAbort?.abort()
        waitAbort = undefined
        windowAttached = false
      }
      const finish = (cb) => {
        if (settled) return false
        settled = true
        pendingQuestions.delete(id)
        cleanup()
        linked.abort()
        notify()
        cb()
        return true
      }
      const onAbort = () => {
        finish(() => reject(userQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')))
      }
      const userQuestions = serviceOf(ctx, 'userQuestions')
      const attachWindow = () => {
        if (settled || !isTimed || windowAttached || typeof userQuestions?.attachWait !== 'function') return
        windowAttached = true
        const localAbort = new AbortController()
        waitAbort = localAbort
        void (async () => {
          try {
            for await (const frame of userQuestions.attachWait(agent, request.wait.callId, localAbort.signal)) {
              if (settled || localAbort.signal.aborted) break
              const remainingMs = Number(frame?.remainingMs)
              if (Number.isFinite(remainingMs) && remainingMs >= 0) {
                entry.deadlineAt = Date.now() + remainingMs
                notify()
                clearTimeout(waitTimer)
                waitTimer = setTimeout(() => {
                  finish(() => reject(userQuestionError('ask_user_question timed out before the user answered', 'ASK_TIMED_OUT')))
                }, remainingMs)
                waitTimer.unref?.()
              }
            }
          } catch {
            // Wait closed or aborted; original signal / settlement handles completion.
          }
        })()
      }
      const entry = {
        id,
        sessionId,
        ...(typeof callId === 'string' && callId !== '' ? { callId } : {}),
        kind: kindOfQuestions(questions),
        timed: isTimed,
        questions,
        at: Date.now(),
        resolve: value => finish(() => resolve(value)),
        reject: err => finish(() => reject(err)),
        attachWindow,
        releaseWindow: () => {
          // When the local desktop window disconnects, release the timed-wait claim so the Host
          // resumes its unattended timer and clear any stale countdown, or reject non-timed
          // questions with NO_PROVIDER so no turn hangs waiting for a closed window.
          waitAbort?.abort()
          waitAbort = undefined
          windowAttached = false
          clearTimeout(waitTimer)
          waitTimer = undefined
          if (!isTimed) {
            finish(() => reject(userQuestionError('no user-questions answerer accepted the request', 'NO_PROVIDER')))
          } else if (entry.deadlineAt !== undefined) {
            delete entry.deadlineAt
            notify()
          }
        },
      }
      pendingQuestions.set(id, entry)
      original?.addEventListener?.('abort', onAbort, { once: true })
      notify()
      if (original?.aborted) { onAbort(); return }

      // For timed questions (`askTimed`), attach a foreground wait claim via `ctx.userQuestions.attachWait`
      // so the Host pauses its unattended fallback timer while the desktop window shows the card and
      // sends us the authoritative remaining duration.
      attachWindow()

      request.signal = linked.signal
      Promise.resolve().then(next).then(
        (value) => { finish(() => resolve(value)) },
        (error) => {
          if (settled || error?.code === 'NO_PROVIDER') return
          finish(() => reject(error))
        },
      )
    })
  }, { prepend: true })

  const onLocalFeedLost = () => {
    for (const entry of Array.from(pendingQuestions.values())) {
      entry.releaseWindow()
    }
  }

  const onLocalFeedConnected = () => {
    for (const entry of Array.from(pendingQuestions.values())) {
      entry.attachWindow?.()
    }
  }

  ctx.on?.('session/event', (session, event) => {
    if (!session?.id || !CONTROL_EVENTS.has(event?.type)) return
    if (isOwnedSession(session.id)) notify()
  })

  const PROJECTION_KEYS = new Set(['inbox', 'plan', 'permissions', 'modelSelection', 'userQuestions'])
  const offProjections = serviceOf(ctx, 'sessionProjections')?.onEventChanged?.((session, changes) => {
    if (!session?.id || !isOwnedSession(session.id) || !changes || typeof changes !== 'object') return
    if ('userQuestions' in changes) observedColdQuestions.delete(session.id)
    for (const key of Object.keys(changes)) {
      if (PROJECTION_KEYS.has(key)) { notify(); break }
    }
  })

  function continuedQuestionsFromValues(sessionId, values, inboxOverride) {
    const active = values?.userQuestions?.active
    if (!Array.isArray(active) || active.length === 0) return []
    const inbox = inboxOverride ?? values?.inbox
    const queuedCalls = new Set()
    for (const msg of [...(inbox?.['next-step'] ?? []), ...(inbox?.['next-turn'] ?? [])]) {
      if (msg?.source?.kind === 'user-question-reply' && typeof msg.source.callId === 'string') {
        queuedCalls.add(msg.source.callId)
      }
    }
    const blockingCalls = new Set(
      [...pendingQuestions.values()]
        .filter(item => item.sessionId === sessionId && item.callId)
        .map(item => item.callId),
    )
    const out = []
    for (const row of active) {
      if (row?.state !== 'continued' || typeof row.callId !== 'string') continue
      if (queuedCalls.has(row.callId) || blockingCalls.has(row.callId)) continue
      const questions = (Array.isArray(row.questions) ? row.questions : []).map(normalizeQuestionItem).filter(Boolean)
      if (questions.length === 0) continue
      out.push({
        id: `continued:${row.callId}`,
        sessionId,
        callId: row.callId,
        kind: kindOfQuestions(questions),
        mode: 'continued',
        questions,
        at: Number.isFinite(row.at) ? row.at : 0,
      })
    }
    return out
  }

  function continuedQuestionsFor(agent, inboxOverride) {
    const projections = serviceOf(ctx, 'sessionProjections')
    if (projections === undefined || agent?.session === undefined) return []
    let values
    try {
      values = projections.snapshot(agent.session, ['userQuestions', 'inbox']).values
    } catch {
      return []
    }
    return continuedQuestionsFromValues(agent.session.id, values, inboxOverride)
  }

  function userQuestionsView() {
    const list = []
    const seenKeys = new Set()
    for (const entry of pendingQuestions.values()) {
      seenKeys.add(`${entry.sessionId}:${entry.callId ?? entry.id}`)
      list.push({
        id: entry.id,
        sessionId: entry.sessionId,
        ...(entry.callId !== undefined ? { callId: entry.callId } : {}),
        kind: entry.kind,
        mode: 'blocking',
        ...(entry.timed ? { timed: true } : {}),
        ...(entry.deadlineAt !== undefined ? { deadlineAt: entry.deadlineAt } : {}),
        questions: entry.questions,
        at: entry.at,
      })
    }
    const seenSessions = new Set()
    const agents = serviceOf(ctx, 'agents')?.list?.() ?? []
    for (const agent of agents) {
      if (!agent?.session?.id || !isDrawableQuestionSession(agent.session.id)) continue
      seenSessions.add(agent.session.id)
      observedColdQuestions.delete(agent.session.id)
      for (const item of continuedQuestionsFor(agent)) {
        const key = `${item.sessionId}:${item.callId}`
        if (!seenKeys.has(key)) { seenKeys.add(key); list.push(item) }
      }
    }
    // Retained non-live sessions with durable `userQuestions` projection state.
    const projections = serviceOf(ctx, 'sessionProjections')
    const sessions = serviceOf(ctx, 'sessions')?.list?.() ?? []
    if (projections !== undefined) {
      for (const session of sessions) {
        if (!session?.id || seenSessions.has(session.id) || !isDrawableQuestionSession(session.id)) continue
        seenSessions.add(session.id)
        try {
          const values = projections.snapshot(session, ['userQuestions', 'inbox']).values
          for (const item of continuedQuestionsFromValues(session.id, values)) {
            const key = `${item.sessionId}:${item.callId}`
            if (!seenKeys.has(key)) { seenKeys.add(key); list.push(item) }
          }
        } catch { /* ignore unreadable projections */ }
      }
    }
    // Cold sessions already observed via `readControls` (`observeSession`) after a Host restart.
    for (const [sid, items] of observedColdQuestions.entries()) {
      if (seenSessions.has(sid) || !isDrawableQuestionSession(sid)) {
        if (!isDrawableQuestionSession(sid)) observedColdQuestions.delete(sid)
        continue
      }
      for (const item of items) {
        const key = `${item.sessionId}:${item.callId}`
        if (!seenKeys.has(key)) { seenKeys.add(key); list.push(item) }
      }
    }
    return list
  }

  function sessionQueuesView() {
    const queues = {}
    const seen = new Set()
    const agents = serviceOf(ctx, 'agents')?.list?.() ?? []
    for (const agent of agents) {
      const id = agent?.session?.id ?? agent?.id
      if (!id || !isOwnedSession(id)) continue
      seen.add(id)
      const rows = serializeQueueRows(agent.inbox?.nextTurn)
      if (rows.length > 0) queues[id] = rows
    }
    // Check retained non-live sessions with pending durable inbox entries if projections are available.
    const projections = serviceOf(ctx, 'sessionProjections')
    const sessions = serviceOf(ctx, 'sessions')?.list?.() ?? []
    if (projections !== undefined) {
      for (const session of sessions) {
        if (!session?.id || seen.has(session.id) || !isOwnedSession(session.id)) continue
        try {
          const inbox = projections.snapshot(session, ['inbox']).values?.inbox
          const rows = serializeQueueRows(inbox?.['next-turn'])
          if (rows.length > 0) queues[session.id] = rows
        } catch { /* ignore unreadable projections */ }
      }
    }
    return queues
  }

  function isPlanAvailable(liveAgent, projValues) {
    if (projValues?.plan?.active === true || projValues?.plan?.pending === true) return true
    if (serviceOf(ctx, 'planMode') !== undefined) return true
    const commands = serviceOf(ctx, 'commands')
    const presets = serviceOf(ctx, 'agentPresets')
    if (liveAgent !== undefined) {
      if (presets?.serviceFor?.(liveAgent, 'planMode') !== undefined) return true
      if (typeof commands?.list === 'function' && commands.list(liveAgent).some(cmd => cmd?.name === 'plan')) return true
      return false
    }
    // Cold session: inspect its recorded or default preset composition without waking the Agent.
    const presetId = (typeof projValues?.agentPreset === 'string' && projValues.agentPreset !== '' ? projValues.agentPreset : null)
      ?? presets?.defaultId
    if (presetId && typeof presets?.inspectCompositions === 'function') {
      try {
        const compositions = presets.inspectCompositions()
        if (Array.isArray(compositions) && compositions.some(comp => comp?.id === presetId
          && Array.isArray(comp.modules) && comp.modules.some(mod => mod?.moduleName === '@deepseek-ai/dsh-plan-mode'))) {
          return true
        }
      } catch { /* ignore unavailable composition inventory */ }
    }
    if (typeof commands?.list === 'function' && commands.list(undefined).some(cmd => cmd?.name === 'plan')) return true
    return false
  }

  async function readControls(sessionId, signal) {
    await rt.load()
    if (!isOwnedSession(sessionId)) throw notFound('Unknown session')
    const liveAgent = serviceOf(ctx, 'agents')?.get?.(sessionId)
    let projValues = {}
    if (liveAgent?.session !== undefined) {
      observedColdQuestions.delete(sessionId)
      try {
        projValues = serviceOf(ctx, 'sessionProjections')?.snapshot?.(
          liveAgent.session,
          ['modelSelection', 'permissions', 'plan', 'inbox', 'userQuestions', 'agentPreset'],
        )?.values ?? {}
      } catch {
        projValues = {}
      }
    } else if (typeof serviceOf(ctx, 'sessionQuery')?.observeSession === 'function') {
      try {
        const obs = await serviceOf(ctx, 'sessionQuery').observeSession(sessionId, signal ? { signal } : undefined)
        try {
          projValues = obs?.projections?.values ?? {}
        } finally {
          obs?.[Symbol.dispose]?.()
        }
      } catch (error) {
        if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') throw notFound(`Session "${sessionId}" not found`)
      }
    }

    // Model & reasoning effort for the session.
    const liveSel = liveAgent?.model?.current?.()
    const projSel = projValues?.modelSelection?.next ?? projValues?.modelSelection?.lastUsed
    const defaultSel = serviceOf(ctx, 'agentDefaultModel')?.currentSelection?.()
    const picked = (liveSel?.provider && liveSel?.model ? { ...liveSel, source: 'session' } : undefined)
      ?? (projSel?.provider && projSel?.model ? { ...projSel, source: 'session' } : undefined)
      ?? (defaultSel?.provider && defaultSel?.model ? { ...defaultSel, source: 'default' } : undefined)
    const ref = picked ? `${picked.provider}/${picked.model}` : null
    const reasoning = ref ? await rt.reasoningOf?.(ref).catch(() => undefined) : undefined
    const effort = typeof picked?.reasoningEffort === 'string' && picked.reasoningEffort !== ''
      ? picked.reasoningEffort
      : null

    // Permission presets for the session (includes session-only presets such as 'auto').
    const permService = serviceOf(ctx, 'permissionPresets')
    let permission = null
    if (permService !== undefined) {
      const cat = permService.catalog?.()
      const current = (liveAgent?.session ? permService.current?.(liveAgent.session) : undefined)
        ?? projValues?.permissions?.currentValue
        ?? cat?.defaultPreset
        ?? null
      permission = {
        current,
        defaultPreset: cat?.defaultPreset ?? null,
        options: Array.isArray(cat?.options)
          ? cat.options.map(opt => ({
            value: opt.value,
            name: opt.name,
            ...(typeof opt.description === 'string' ? { description: opt.description } : {}),
          }))
          : [],
      }
    }

    // Plan mode projection state & preset availability.
    const planRaw = projValues?.plan
    const plan = {
      active: planRaw?.active === true,
      pending: planRaw?.pending === true,
      available: isPlanAvailable(liveAgent, projValues),
    }

    const queue = liveAgent !== undefined
      ? serializeQueueRows(liveAgent.inbox?.nextTurn)
      : serializeQueueRows(projValues?.inbox?.['next-turn'])

    // Surface persisted `continued` questions for cold sessions too, and remember them for `live()`
    // so `ClassicQuestionDock` sees them immediately without waking the cold Agent.
    if (liveAgent === undefined) {
      const coldContinued = continuedQuestionsFromValues(sessionId, projValues)
      const prevJson = JSON.stringify(observedColdQuestions.get(sessionId) ?? [])
      const nextJson = JSON.stringify(coldContinued)
      if (coldContinued.length > 0) observedColdQuestions.set(sessionId, coldContinued)
      else observedColdQuestions.delete(sessionId)
      if (prevJson !== nextJson) notify()
    }

    const questions = userQuestionsView().filter(item => item.sessionId === sessionId)

    return {
      sessionId,
      model: {
        ref,
        provider: picked?.provider ?? null,
        model: picked?.model ?? null,
        effort,
        source: picked?.source ?? null,
        ...(reasoning ? { reasoning } : {}),
      },
      permission,
      plan,
      queue,
      questions,
    }
  }

  async function selectClassicModel(body, signal) {
    writeCheck()
    await rt.load()
    const sessionId = requireSessionId(body?.sessionId)
    if (!isOwnedClassic(sessionId)) throw refused('Session model selection applies to Classic sessions only')
    const controller = serviceOf(ctx, 'sessionController')
    if (typeof controller?.selectModel !== 'function') throw refused('Model selection is unavailable on this host')

    const currentControls = await readControls(sessionId, signal)
    const rawRef = body?.ref === undefined || body?.ref === null ? currentControls.model?.ref : String(body.ref).trim()
    if (!rawRef) throw invalid('Choose a model first')
    const ref = await rt.resolveModel(rawRef)
    const { provider, model } = splitRef(ref)
    if (!provider || !model) throw invalid('Invalid model reference')

    let reasoningEffort
    if (body?.effort !== undefined) {
      if (body.effort === null || body.effort === '') {
        reasoningEffort = undefined
      } else {
        reasoningEffort = await rt.resolveEffort(ref, String(body.effort))
      }
    } else if (ref === currentControls.model?.ref && currentControls.model?.effort) {
      reasoningEffort = await rt.resolveEffort(ref, currentControls.model.effort).catch(() => undefined)
    }

    try {
      await controller.selectModel({
        sessionId,
        provider,
        model,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      })
    } catch (error) {
      throw windowError(error)
    }
    notify()
    return await readControls(sessionId, signal)
  }

  async function setClassicPermission(body, signal) {
    writeCheck()
    await rt.load()
    const sessionId = requireSessionId(body?.sessionId)
    if (!isOwnedClassic(sessionId)) throw refused('Session permission preset applies to Classic sessions only')
    const preset = typeof body?.preset === 'string' ? body.preset.trim() : ''
    if (preset === '') throw invalid('Choose a permission preset')
    const permService = serviceOf(ctx, 'permissionPresets')
    if (permService === undefined) throw refused('Permissions are not available on this host')
    // Validate preset name against DSH's registry before touching the session.
    try {
      permService.resolve(preset)
    } catch (error) {
      throw invalid(error?.message || `Unknown permission preset "${preset}"`)
    }
    const agent = await rt.resolveAgent(sessionId)
    const commands = serviceOf(ctx, 'commands')
    const hasPermissionCmd = typeof commands?.list === 'function'
      && commands.list(agent).some(cmd => cmd?.name === 'permission')
    if (hasPermissionCmd && typeof commands?.execute === 'function') {
      const exec = await commands.execute(agent, `/permission ${preset}`, [], signal ?? AbortSignal.timeout(15_000))
      if (exec?.result?.kind === 'error') throw refused(exec.result.text || 'Could not change permission preset')
    } else {
      permService.set(agent.session, preset)
    }
    notify()
    return await readControls(sessionId, signal)
  }

  async function listCommands(body) {
    await rt.load()
    const sessionId = requireSessionId(body?.sessionId)
    if (!isOwnedClassic(sessionId)) return { commands: [] }
    const commands = serviceOf(ctx, 'commands')
    if (typeof commands?.list !== 'function') return { commands: [] }
    const liveAgent = serviceOf(ctx, 'agents')?.get?.(sessionId)
    // Never wake a cold Agent from browsing sessions; only resolve when explicitly asked (`wake: true`)
    // and the host is writable. Otherwise return global commands (`commands.list(undefined)`).
    let agent = liveAgent
    if (agent === undefined && body?.wake === true && rt.readOnly?.() === undefined) {
      agent = await rt.resolveAgent(sessionId)
    }
    const list = commands.list(agent) ?? []
    return {
      commands: list.map(item => ({
        name: item.name,
        description: item.description ?? '',
        ...(item.input !== undefined ? { input: item.input } : {}),
        ...(item.definitionId !== undefined ? { definitionId: item.definitionId } : {}),
      })),
    }
  }

  async function runCommand(body, signal) {
    writeCheck()
    await rt.load()
    const sessionId = requireSessionId(body?.sessionId)
    if (!isOwnedClassic(sessionId)) throw refused('Host commands run in Classic sessions only')
    const line = typeof body?.line === 'string' ? body.line.trim() : ''
    if (!line.startsWith('/') || line.length < 2) throw invalid('A slash command is required')
    const commands = serviceOf(ctx, 'commands')
    if (typeof commands?.execute !== 'function') throw refused('Commands are not available on this host')
    const claimed = typeof body?.claimAttachments === 'function'
      ? await body.claimAttachments(sessionId, signal)
      : { submittedAttachments: Array.isArray(body?.submittedAttachments) ? body.submittedAttachments : [], restore: () => {} }
    let execution
    try {
      const agent = await rt.resolveAgent(sessionId)
      execution = await commands.execute(agent, line, claimed.submittedAttachments, signal ?? AbortSignal.timeout(30_000))
    } catch (error) {
      claimed.restore?.()
      throw error
    }
    notify()
    if (execution === undefined) {
      return { matched: false, result: null }
    }
    return {
      matched: true,
      result: execution.result ?? null,
      controls: await readControls(sessionId, signal).catch(() => undefined),
    }
  }

  async function listSkills(body, signal) {
    await rt.load()
    const sessionId = requireSessionId(body?.sessionId)
    if (!isOwnedClassic(sessionId)) return { skills: [] }
    const catalog = serviceOf(ctx, 'sessionSkillCatalog')
    if (typeof catalog?.list !== 'function') return { skills: [] }
    try {
      const value = await catalog.list({ sessionId }, signal ?? AbortSignal.timeout(15_000))
      return { skills: Array.isArray(value?.skills) ? value.skills : [] }
    } catch {
      return { skills: [] }
    }
  }

  async function listFiles(body, signal) {
    await rt.load()
    const sessionId = requireSessionId(body?.sessionId)
    if (!isOwnedClassic(sessionId)) return { files: [] }
    const refs = serviceOf(ctx, 'fileReferences')
    if (typeof refs?.list !== 'function') return { files: [] }
    const liveAgent = serviceOf(ctx, 'agents')?.get?.(sessionId)
    if (liveAgent === undefined && rt.readOnly?.() !== undefined) return { files: [] }
    const query = typeof body?.query === 'string' ? body.query.slice(0, 500) : ''
    try {
      const agent = liveAgent ?? await rt.resolveAgent(sessionId)
      const list = await refs.list(agent, query, signal ?? AbortSignal.timeout(10_000))
      return {
        files: Array.isArray(list)
          ? list.map(entry => ({
            path: String(entry.path ?? ''),
            kind: entry.kind === 'directory' ? 'directory' : 'file',
          })).filter(entry => entry.path !== '')
          : [],
      }
    } catch {
      return { files: [] }
    }
  }

  async function answerUserQuestion(body) {
    writeCheck()
    await rt.load()
    const sessionId = requireSessionId(body?.sessionId)
    if (!isDrawableQuestionSession(sessionId)) throw notFound('Unknown session')
    const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : ''
    if (requestId === '') throw invalid('A question id is required')

    const entry = pendingQuestions.get(requestId)
    if (entry !== undefined) {
      if (entry.sessionId !== sessionId) throw stale('This question is no longer open')
      const answers = normalizeAnswers(body?.answers, entry.questions)
      pendingQuestions.delete(requestId)
      entry.resolve({ answers })
      return { accepted: true }
    }

    if (requestId.startsWith('continued:')) {
      const callId = requestId.slice('continued:'.length)
      const userQuestions = serviceOf(ctx, 'userQuestions')
      if (typeof userQuestions?.answer !== 'function') throw stale('This question is no longer open')
      const agent = await rt.resolveAgent(sessionId)
      observedColdQuestions.delete(sessionId)
      const match = continuedQuestionsFor(agent).find(item => item.callId === callId)
      if (match === undefined) throw stale('This question is no longer open')
      const answers = normalizeAnswers(body?.answers, match.questions)
      const accepted = userQuestions.answer(agent, callId, { answers })
      notify()
      if (!accepted) throw stale('This question is no longer open')
      return { accepted: true }
    }

    throw stale('This question is no longer open')
  }

  async function dismissUserQuestion(body) {
    writeCheck()
    await rt.load()
    const sessionId = requireSessionId(body?.sessionId)
    if (!isDrawableQuestionSession(sessionId)) throw notFound('Unknown session')
    const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : ''
    if (requestId === '') throw invalid('A question id is required')
    const entry = pendingQuestions.get(requestId)
    if (entry === undefined || entry.sessionId !== sessionId) throw stale('This question is no longer open')
    pendingQuestions.delete(requestId)
    entry.reject(userQuestionError('Cancelled by user', 'ASK_CANCELLED'))
    return { accepted: true }
  }

  async function updateQueue(body) {
    writeCheck()
    await rt.load()
    const sessionId = requireSessionId(body?.sessionId)
    if (!isOwnedSession(sessionId)) throw notFound('Unknown session')
    const action = body?.action
    if (!action || typeof action !== 'object') throw invalid('A queue action is required')
    const controller = serviceOf(ctx, 'sessionController')
    if (typeof controller?.updateQueue !== 'function') throw refused('Queue actions are unavailable on this host')

    if (action.kind === 'steer-all') {
      const ids = Array.isArray(body?.itemIds) ? body.itemIds.filter(id => typeof id === 'string' && id !== '') : undefined
      if (isForegroundBotSession(sessionId) && typeof rt.steerQueued === 'function') {
        const outcome = rt.steerQueued(sessionId, ids)
        if (outcome?.fallback !== true) {
          notify()
          return { accepted: (outcome?.steered ?? 0) > 0, steered: outcome?.steered ?? 0 }
        }
      }
      const liveAgent = serviceOf(ctx, 'agents')?.get?.(sessionId)
      const userRows = serializeQueueRows(liveAgent?.inbox?.nextTurn).filter(row => row.source?.kind === 'user')
      const wanted = ids ? userRows.filter(row => ids.includes(row.id)) : userRows
      let steered = 0
      for (const row of wanted) {
        try {
          await controller.updateQueue({ sessionId, itemId: row.id, action: { kind: 'steer' } })
          steered += 1
        } catch (error) {
          if (error?.code === 'session/queue-item-not-found' || error?.code === 'session/steer-unavailable') break
          throw windowError(error)
        }
      }
      notify()
      return { accepted: steered > 0, steered }
    }

    const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : ''
    if (itemId === '') throw invalid('A queued item id is required')

    if (action.kind === 'steer') {
      if (isForegroundBotSession(sessionId) && typeof rt.steerQueued === 'function') {
        const outcome = rt.steerQueued(sessionId, [itemId], { kinds: OWN_QUEUE_KINDS })
        if (outcome?.fallback !== true) {
          notify()
          const steered = outcome?.steered ?? 0
          if (steered > 0) return { accepted: true, steered }
          const stillQueued = (serviceOf(ctx, 'agents')?.get?.(sessionId)?.inbox?.nextTurn ?? []).some(row => row?.id === itemId)
          return {
            accepted: false,
            steered: 0,
            code: stillQueued ? 'session/steer-unavailable' : 'session/queue-item-not-found',
          }
        }
      }
      try {
        await controller.updateQueue({ sessionId, itemId, action: { kind: 'steer' } })
        notify()
        return { accepted: true }
      } catch (error) {
        if (error?.code === 'session/queue-item-not-found' || error?.code === 'session/steer-unavailable') {
          notify()
          return { accepted: false, code: error.code }
        }
        throw windowError(error)
      }
    }

    if (action.kind === 'remove') {
      try {
        await controller.updateQueue({ sessionId, itemId, action: { kind: 'remove' } })
        notify()
        return { accepted: true }
      } catch (error) {
        if (error?.code === 'session/queue-item-not-found') {
          notify()
          return { accepted: false, code: error.code }
        }
        throw windowError(error)
      }
    }

    if (action.kind === 'edit') {
      const text = typeof action.text === 'string' ? action.text : ''
      if (text.trim() === '') throw invalid('Message text is required')
      // Defense in depth: reject editing queued rows that contain non-text blocks so attachments are never dropped.
      const liveAgent = serviceOf(ctx, 'agents')?.get?.(sessionId)
      const existingRow = liveAgent?.inbox?.nextTurn?.find?.(row => row?.id === itemId)
        ?? (() => {
          const retained = serviceOf(ctx, 'sessions')?.list?.()?.find?.(item => item?.id === sessionId)
          const projections = serviceOf(ctx, 'sessionProjections')
          if (!retained || typeof projections?.snapshot !== 'function') return undefined
          try {
            return projections.snapshot(retained, ['inbox']).values?.inbox?.['next-turn']?.find?.(row => row?.id === itemId)
          } catch {
            return undefined
          }
        })()
      if (Array.isArray(existingRow?.content) && existingRow.content.some(block => block?.type !== 'text')) {
        throw invalid('Queued messages with non-text content cannot be edited')
      }
      try {
        await controller.updateQueue({ sessionId, itemId, action: { kind: 'edit', content: [{ type: 'text', text }] } })
        notify()
        return { accepted: true }
      } catch (error) {
        if (error?.code === 'session/queue-item-not-found') {
          notify()
          return { accepted: false, code: error.code }
        }
        throw windowError(error)
      }
    }

    throw invalid('Unknown queue action')
  }

  const SESSION_CONTROL_NAMES = new Set([
    'controls',
    'model',
    'permission',
    'commands',
    'command-run',
    'skills',
    'files',
    'question-answer',
    'question-dismiss',
    'queue-update',
  ])

  const sessionControlsEndpoint = async (name, body = {}, signal) => {
    switch (name) {
      case 'controls':
        return await readControls(requireSessionId(body?.sessionId), signal)
      case 'model':
        return await selectClassicModel(body, signal)
      case 'permission':
        return await setClassicPermission(body, signal)
      case 'commands':
        return await listCommands(body)
      case 'command-run':
        return await runCommand(body, signal)
      case 'skills':
        return await listSkills(body, signal)
      case 'files':
        return await listFiles(body, signal)
      case 'question-answer':
        return await answerUserQuestion(body)
      case 'question-dismiss':
        return await dismissUserQuestion(body)
      case 'queue-update':
        return await updateQueue(body)
      default:
        throw notFound(`Unknown endpoint session-${name}`)
    }
  }

  ctx.effect?.(() => () => {
    offProjections?.()
    observedColdQuestions.clear()
    for (const entry of Array.from(pendingQuestions.values())) {
      entry.reject(userQuestionError('DS Bot is shutting down', 'ASK_ABORTED'))
    }
    pendingQuestions.clear()
  }, 'ds-bot: session controls')

  Object.assign(rt, {
    hasSessionControlEndpoint: name => SESSION_CONTROL_NAMES.has(name),
    sessionControlsEndpoint,
    userQuestionsView,
    sessionQueuesView,
    onLocalFeedLost,
    onLocalFeedConnected,
  })
}
