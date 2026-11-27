// Background job observation and human cancellation over `api/bot` using DSH's
// documented `ctx.jobs` service. Reads are strictly non-consuming (`readAt`) so
// inspecting live logs in the desktop window never advances the model's cursor or
// suppresses completion notices. Human cancellation passes `'cancelled by the user'`,
// matching `@deepseek-ai/dsh-api-job-controller`.
import { serviceOf } from './services.js'

const SESSION_ID = /^[\w-]{1,128}$/
const MAX_JOB_ID = 256
const FEED_COALESCE_MS = 200

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const notFound = message => Object.assign(new Error(message), { code: 'bot/not-found' })
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })

function cleanSessionId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!SESSION_ID.test(id)) throw invalid('A Session id is needed')
  return id
}

function cleanJobId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (id === '' || id.length > MAX_JOB_ID) throw invalid('A job id is needed')
  return id
}

function cleanJobView(job) {
  if (!job || typeof job !== 'object') return null
  return {
    id: String(job.id),
    kind: String(job.kind ?? ''),
    label: String(job.label ?? ''),
    status: String(job.status ?? 'running'),
    ...(typeof job.detail === 'string' && job.detail !== '' ? { detail: job.detail } : {}),
    ...(typeof job.progress === 'string' && job.progress !== '' ? { progress: job.progress } : {}),
    startedAt: Number.isFinite(job.startedAt) ? job.startedAt : 0,
    ...(Number.isFinite(job.finishedAt) ? { finishedAt: job.finishedAt } : {}),
    ...(job.owner !== undefined ? { owner: String(job.owner) } : {}),
    output: {
      earliest: Number.isFinite(job.output?.earliest) ? job.output.earliest : 0,
      total: Number.isFinite(job.output?.total) ? job.output.total : 0,
      ...(Array.isArray(job.output?.spillPaths) && job.output.spillPaths.length > 0 ? { spillPaths: [...job.output.spillPaths] } : {}),
    },
  }
}

function chunksText(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return ''
  let out = ''
  for (const chunk of chunks) {
    if (typeof chunk?.text === 'string') out += chunk.text
  }
  return out
}

export function install(rt) {
  const { ctx } = rt

  const emitLocal = (event, data) => {
    if (typeof rt.publishLocalFeed === 'function') rt.publishLocalFeed(event, data)
    else rt.publishFeed?.(event, data)
  }

  const pendingNotices = new Map()

  const scheduleNotice = (sessionId, jobId) => {
    const key = sessionId ?? '*'
    let entry = pendingNotices.get(key)
    if (!entry) {
      entry = { jobIds: new Set(), timer: null }
      pendingNotices.set(key, entry)
    }
    if (jobId) entry.jobIds.add(String(jobId))
    if (entry.timer !== null) return
    entry.timer = setTimeout(() => {
      pendingNotices.delete(key)
      const singleJobId = entry.jobIds.size === 1 ? [...entry.jobIds][0] : undefined
      emitLocal('jobs', {
        ...(sessionId ? { sessionId } : {}),
        ...(singleJobId ? { jobId: singleJobId } : {}),
      })
    }, FEED_COALESCE_MS)
    entry.timer.unref?.()
  }

  let unsubscribe
  const attachEvents = () => {
    if (unsubscribe !== undefined) return
    const jobs = serviceOf(ctx, 'jobs')
    if (typeof jobs?.events?.subscribe !== 'function') return
    try {
      unsubscribe = jobs.events.subscribe({ owners: 'all' }, (event) => {
        const owner = event?.type === 'output' ? event.owner : event?.job?.owner
        const jobId = event?.type === 'output' ? event.id : event?.job?.id
        scheduleNotice(owner, jobId)
      })
    } catch {
      unsubscribe = undefined
    }
  }
  attachEvents()

  ctx.effect?.(() => () => {
    for (const entry of pendingNotices.values()) clearTimeout(entry.timer)
    pendingNotices.clear()
    try { unsubscribe?.() } catch { /* ignore */ }
    unsubscribe = undefined
  }, 'ds-bot: background jobs')

  async function jobEndpoint(name, body = {}) {
    attachEvents()
    const jobs = serviceOf(ctx, 'jobs')

    if (name === 'list') {
      const sessionId = cleanSessionId(body.sessionId)
      if (!jobs || typeof jobs.list !== 'function') return { available: false, jobs: [] }
      const list = jobs.list(sessionId)
      return {
        available: true,
        jobs: (Array.isArray(list) ? list : []).map(cleanJobView).filter(Boolean),
      }
    }

    if (name === 'read') {
      const sessionId = cleanSessionId(body.sessionId)
      const jobId = cleanJobId(body.jobId)
      if (!jobs || typeof jobs.get !== 'function' || typeof jobs.readAt !== 'function') {
        throw notFound('Background jobs are unavailable')
      }
      let from
      if (body.from !== undefined && body.from !== null && body.from !== '') {
        const parsed = Number(body.from)
        if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalid('from must be a non-negative whole number')
        from = parsed
      }
      let current
      try {
        current = jobs.get(jobId, sessionId)
      } catch (error) {
        throw notFound(String(error?.message ?? error))
      }
      if (!current) throw notFound('Job not found')
      const cursor = from ?? (Number.isFinite(current?.output?.earliest) ? current.output.earliest : 0)
      let read
      try {
        read = jobs.readAt(jobId, cursor, sessionId)
      } catch (error) {
        throw notFound(String(error?.message ?? error))
      }
      if (!read) throw notFound('Job not found')
      const refreshed = (() => {
        try { return jobs.get(jobId, sessionId) } catch { return current }
      })()
      const chunks = Array.isArray(read?.chunks) ? read.chunks : []
      return {
        job: cleanJobView(refreshed),
        from: cursor,
        next: Number.isFinite(read?.next) ? read.next : cursor,
        lossy: read?.lossy === true,
        text: chunksText(chunks),
        chunks: chunks.map(chunk => ({
          at: Number.isFinite(chunk?.at) ? chunk.at : 0,
          text: typeof chunk?.text === 'string' ? chunk.text : '',
          ...(typeof chunk?.channel === 'string' ? { channel: chunk.channel } : {}),
          ...(chunk?.gapBefore === true ? { gapBefore: true } : {}),
        })),
      }
    }

    if (name === 'kill') {
      const readOnly = rt.readOnly?.()
      if (readOnly !== undefined) throw Object.assign(new Error(readOnly), { code: 'bot/read-only' })
      const sessionId = cleanSessionId(body.sessionId)
      const jobId = cleanJobId(body.jobId)
      if (!jobs || typeof jobs.get !== 'function' || typeof jobs.kill !== 'function') {
        throw refused('Background jobs are unavailable')
      }
      let found
      try {
        found = jobs.get(jobId, sessionId)
      } catch (error) {
        throw notFound(String(error?.message ?? error))
      }
      if (!found) throw notFound('Job not found')
      const outcome = await jobs.kill(jobId, sessionId, 'cancelled by the user')
      const updated = (() => {
        try { return jobs.get(jobId, sessionId) } catch { return null }
      })()
      return {
        outcome,
        job: cleanJobView(updated),
      }
    }

    throw notFound(`Unknown endpoint job-${name}`)
  }

  rt.jobEndpoint = jobEndpoint
}
