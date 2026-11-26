// Computer-only bridge for DSH `messageFeedback` (`engine-feedback-*` over `api/bot`).
// Lets the desktop app's own window read, submit, and retract reply feedback in Classic
// Agent sessions without reaching into DSH services directly.

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const notFound = message => Object.assign(new Error(message), { code: 'bot/not-found' })
const unavailable = message => Object.assign(new Error(message), { code: 'bot/unavailable' })
const refused = (message, code = 'bot/refused') => Object.assign(new Error(message), { code })

const VALID_RATINGS = new Set(['positive', 'negative'])
const VALID_CATEGORIES = new Set([
  'task-result',
  'instruction-following',
  'product-interaction',
  'service-stability',
  'resource-cost',
  'security-privacy-permission',
  'other',
])

function requireSessionId(body) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  if (sessionId === '') throw invalid('A session id is required')
  return sessionId
}

function requireMessageId(body) {
  const messageId = typeof body?.messageId === 'string' ? body.messageId.trim() : ''
  if (messageId === '') throw invalid('A message id is required')
  return messageId
}

function serializeFeedbackError(err) {
  const code = typeof err?.code === 'string' && err.code !== '' ? err.code : 'INTERNAL'
  const out = { code }
  if (typeof err?.message === 'string' && err.message !== '') out.message = err.message
  if (err && Object.hasOwn(err, 'current')) out.current = err.current
  if (Number.isFinite(err?.maxBytes)) out.maxBytes = err.maxBytes
  if (Number.isFinite(err?.actualBytes)) out.actualBytes = err.actualBytes
  if (typeof err?.sessionId === 'string') out.sessionId = err.sessionId
  if (typeof err?.messageId === 'string') out.messageId = err.messageId
  return out
}

export function isTeamSession(rt, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  if (typeof rt?.isTeamSession === 'function') return rt.isTeamSession(sessionId) === true
  return (
    rt?.isBotSession?.(sessionId) === true
    || rt?.botOf?.(sessionId) !== undefined
    || rt?.roomOf?.(sessionId) !== undefined
    || rt?.chatOwners?.has?.(sessionId) === true
    || rt?.taskOwners?.has?.(sessionId) === true
    || rt?.groupOwners?.has?.(sessionId) === true
    || rt?.roomOwners?.has?.(sessionId) === true
    || rt?.pastOwners?.has?.(sessionId) === true
  )
}

export function install(rt) {
  const { ctx } = rt
  const serviceOf = () => ctx.get?.('messageFeedback') ?? ctx.messageFeedback
  const writeCheck = () => {
    const why = rt.readOnly?.()
    if (why) throw refused(why, 'bot/read-only')
  }
  const classicSessionCheck = async (sessionId) => {
    await rt.load?.()
    if (isTeamSession(rt, sessionId)) {
      throw refused('Message feedback is only available in classic sessions', 'bot/refused')
    }
  }

  rt.feedbackEndpoint = async (name, body = {}) => {
    const service = serviceOf()
    switch (name) {
      case 'list': {
        const sessionId = requireSessionId(body)
        await classicSessionCheck(sessionId)
        if (typeof service?.list !== 'function') {
          return { available: false, items: [] }
        }
        const res = await service.list({ sessionId })
        if (!res?.ok) {
          // A newly opened blank classic session has no persisted log yet, but the service is available.
          if (res?.error?.code === 'session-not-found') {
            return { available: true, items: [] }
          }
          throw refused(res?.error?.message ?? 'Could not load message feedback')
        }
        return {
          available: true,
          items: Array.isArray(res.value?.items) ? res.value.items : [],
        }
      }
      case 'put': {
        writeCheck()
        if (typeof service?.put !== 'function') {
          throw unavailable('Message feedback is not available in this engine')
        }
        const sessionId = requireSessionId(body)
        await classicSessionCheck(sessionId)
        const messageId = requireMessageId(body)
        const rating = typeof body.rating === 'string' ? body.rating : ''
        if (!VALID_RATINGS.has(rating)) throw invalid('A valid feedback rating is required')
        const ifVersion = body.ifVersion === null || body.ifVersion === undefined
          ? null
          : (typeof body.ifVersion === 'string' ? body.ifVersion : null)
        const req = { sessionId, messageId, rating, ifVersion }
        if (typeof body.note === 'string' && body.note !== '') req.note = body.note
        if (typeof body.category === 'string' && body.category !== '') {
          if (!VALID_CATEGORIES.has(body.category)) throw invalid('Unknown feedback category')
          req.category = body.category
        }
        const res = await service.put(req)
        if (res?.ok) return { ok: true, item: res.value }
        return { ok: false, error: serializeFeedbackError(res?.error) }
      }
      case 'delete': {
        writeCheck()
        if (typeof service?.delete !== 'function') {
          throw unavailable('Message feedback is not available in this engine')
        }
        const sessionId = requireSessionId(body)
        await classicSessionCheck(sessionId)
        const messageId = requireMessageId(body)
        const ifVersion = typeof body.ifVersion === 'string' && body.ifVersion !== '' ? body.ifVersion : ''
        if (ifVersion === '') throw invalid('A feedback version is required')
        const res = await service.delete({ sessionId, messageId, ifVersion })
        if (res?.ok) return { ok: true, absent: true }
        return { ok: false, error: serializeFeedbackError(res?.error) }
      }
      default:
        throw notFound(`Unknown endpoint engine-feedback-${name}`)
    }
  }
}
