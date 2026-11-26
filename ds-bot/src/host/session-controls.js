// Per-session controls, queue management, slash/skill/file discovery, and DSH
// user-questions/plan-review bridging for DS Bot's own desktop window over `/api/bot`.
// Keeps DSH Web plugin mode untouched: the `user-questions/request` listener runs after
// Typert and only claims a request when no DSH Web UI provider answered (`NO_PROVIDER`).
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
  /** @type {Map<string, { id: string, sessionId: string, callId?: string, kind: 'question' | 'plan-review', questions: object[], at: number, resolve: (value: object) => void, reject: (error: Error) => void, cleanup: () => void }>} */
  const pendingQuestions = new Map()

  const notify = () => { rt.notifyLive?.() }

  const isOwnedClassic = sessionId => rt.agentOf?.(sessionId) !== undefined
  const isOwnedSession = sessionId => isOwnedClassic(sessionId)
    || rt.selfOf?.(sessionId) !== undefined
    || rt.chatOwners?.has?.(sessionId) === true
    || rt.roomOf?.(sessionId) !== undefined
    || rt.botOf?.(sessionId) !== undefined

  const writeCheck = () => {
    const reason = rt.readOnly?.()
    if (reason !== undefined) throw Object.assign(new Error(reason), { code: 'bot/read-only' })
  }

  // Answerer bridge for DSH `user-questions/request` (`ask_user_question` and `exit_plan_mode`
  // plan review). Prepend like `approvals.js` and `computer/index.js`: DSH's remote-events
  // bridge registers ahead of ds-bot and holds requests waiting for a DSH Web client that
  // DS Bot's own desktop window never connects. We race `next()` with a linked AbortController
  // so DS Bot's own window can answer immediately while DSH Web plugin mode still answers
  // seamlessly through `next()` (cancelling the other side as soon as either settles).
  ctx.on?.('user-questions/request', async (request, next) => {
    const rawQuestions = Array.isArray(request?.questions) ? request.questions : []
    // Leave computer-use consent and approval-intent questions to `computer/index.js` and DSH.
    if (rawQuestions.some(q => q?.id === 'cua-mouse-control' || q?.id === 'cua-app-access' || q?.intent?.kind === 'approval')) {
      return await next()
    }
    const agent = request?.agent
    const sessionId = agent?.session?.id ?? agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return await next()
    await rt.load()
    if (!isOwnedSession(sessionId)) return await next()
    if (request.signal?.aborted) {
      throw userQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    }
    const questions = rawQuestions.map(normalizeQuestionItem).filter(Boolean)
    if (questions.length === 0) {
      throw userQuestionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS')
    }
    const id = randomUUID()
    const callId = request.wait?.callId ?? questions[0]?.intent?.callId
    const original = request.signal
    const linked = new AbortController()
    return await new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        original?.removeEventListener?.('abort', onAbort)
        if (request.signal === linked.signal) request.signal = original
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
      pendingQuestions.set(id, {
        id,
        sessionId,
        ...(typeof callId === 'string' && callId !== '' ? { callId } : {}),
        kind: kindOfQuestions(questions),
        questions,
        at: Date.now(),
        resolve: value => finish(() => resolve(value)),
        reject: err => finish(() => reject(err)),
        cleanup: () => {
          settled = true
          cleanup()
          linked.abort()
        },
      })
      original?.addEventListener?.('abort', onAbort, { once: true })
      notify()
      if (original?.aborted) { onAbort(); return }
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

  ctx.on?.('session/event', (session, event) => {
    if (!session?.id || !CONTROL_EVENTS.has(event?.type)) return
    if (isOwnedSession(session.id)) notify()
  })

  const PROJECTION_KEYS = new Set(['inbox', 'plan', 'permissions', 'modelSelection', 'userQuestions'])
  const offProjections = serviceOf(ctx, 'sessionProjections')?.onEventChanged?.((session, changes) => {
    if (!session?.id || !isOwnedSession(session.id) || !changes || typeof changes !== 'object') return
    for (const key of Object.keys(changes)) {
      if (PROJECTION_KEYS.has(key)) { notify(); break }
    }
  })

  function continuedQuestionsFor(agent, inboxOverride) {
    const projections = serviceOf(ctx, 'sessionProjections')
    if (projections === undefined || agent?.session === undefined) return []
    let values
    try {
      values = projections.snapshot(agent.session, ['userQuestions', 'inbox']).values
    } catch {
      return []
    }
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
        .filter(item => item.sessionId === agent.session.id && item.callId)
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
        sessionId: agent.session.id,
        callId: row.callId,
        kind: kindOfQuestions(questions),
        mode: 'continued',
        questions,
        at: Number.isFinite(row.at) ? row.at : 0,
      })
    }
    return out
  }

  function userQuestionsView() {
    const list = []
    for (const entry of pendingQuestions.values()) {
      list.push({
        id: entry.id,
        sessionId: entry.sessionId,
        ...(entry.callId !== undefined ? { callId: entry.callId } : {}),
        kind: entry.kind,
        mode: 'blocking',
        questions: entry.questions,
        at: entry.at,
      })
    }
    const agents = serviceOf(ctx, 'agents')?.list?.() ?? []
    for (const agent of agents) {
      if (!agent?.session?.id || !isOwnedSession(agent.session.id)) continue
      list.push(...continuedQuestionsFor(agent))
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

  async function readControls(sessionId, signal) {
    await rt.load()
    if (!isOwnedSession(sessionId)) throw notFound('Unknown session')
    const liveAgent = serviceOf(ctx, 'agents')?.get?.(sessionId)
    let projValues = {}
    if (liveAgent?.session !== undefined) {
      try {
        projValues = serviceOf(ctx, 'sessionProjections')?.snapshot?.(
          liveAgent.session,
          ['modelSelection', 'permissions', 'plan', 'inbox'],
        )?.values ?? {}
      } catch {
        projValues = {}
      }
    } else if (typeof serviceOf(ctx, 'sessionQuery')?.observeSession === 'function') {
      try {
        const obs = await serviceOf(ctx, 'sessionQuery').observeSession(sessionId, signal)
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

    // Plan mode projection state.
    const planRaw = projValues?.plan
    const plan = {
      active: planRaw?.active === true,
      pending: planRaw?.pending === true,
      available: Boolean(serviceOf(ctx, 'planMode')) || planRaw?.active === true || planRaw?.pending === true,
    }

    const queue = liveAgent !== undefined
      ? serializeQueueRows(liveAgent.inbox?.nextTurn)
      : serializeQueueRows(projValues?.inbox?.['next-turn'])

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
    permService.resolve(preset)
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
    if (liveAgent === undefined && rt.readOnly?.() !== undefined) return { commands: [] }
    const agent = liveAgent ?? await rt.resolveAgent(sessionId)
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
    const agent = await rt.resolveAgent(sessionId)
    const execution = await commands.execute(agent, line, [], signal ?? AbortSignal.timeout(30_000))
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

    const isForegroundBot = () => {
      const botId = rt.chatOwners?.get?.(sessionId)
      return botId !== undefined
        && (typeof rt.chatOf !== 'function' || rt.chatOf(botId) === sessionId)
        && !rt.groupOwners?.has?.(sessionId)
        && !rt.taskOwners?.has?.(sessionId)
    }

    if (action.kind === 'steer-all') {
      const ids = Array.isArray(body?.itemIds) ? body.itemIds.filter(id => typeof id === 'string' && id !== '') : undefined
      if (isForegroundBot() && typeof rt.steerQueued === 'function') {
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
      if (isForegroundBot() && typeof rt.steerQueued === 'function') {
        const outcome = rt.steerQueued(sessionId, [itemId])
        if (outcome?.steered > 0) {
          notify()
          return { accepted: true, steered: outcome.steered }
        }
        if (outcome?.fallback !== true) {
          // Item may no longer be pending or agent stopped; verify cleanly through DSH.
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

  const prevSessionEndpoint = rt.sessionEndpoint
  rt.sessionEndpoint = async (name, body = {}, signal) => {
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
        if (typeof prevSessionEndpoint === 'function') return await prevSessionEndpoint(name, body, signal)
        throw notFound(`Unknown endpoint session-${name}`)
    }
  }

  ctx.effect?.(() => () => {
    offProjections?.()
    for (const entry of Array.from(pendingQuestions.values())) {
      pendingQuestions.delete(entry.id)
      entry.cleanup()
      entry.reject(userQuestionError('DS Bot is shutting down', 'ASK_ABORTED'))
    }
    pendingQuestions.clear()
  }, 'ds-bot: session controls')

  Object.assign(rt, {
    userQuestionsView,
    sessionQueuesView,
  })
}
