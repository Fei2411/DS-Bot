// External API /v1/* service handlers and HTTP + SSE route dispatcher.
// Exported `service` methods are shared verbatim by REST routes, MCP (/mcp), and OpenAI compat.
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openTasksOf } from '../tasks.js'
import { API_ACTOR } from '../roster.js'
import { AvatarValidationError, mimeOf } from '../avatar.js'

const PKG = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))

export const JSON_BODY_LIMIT = 2 * 1024 * 1024 // 2 MiB
export const UPLOAD_BODY_LIMIT = 32 * 1024 * 1024 // 32 MiB
const UPLOAD_TTL_MS = 30 * 60_000
const UPLOADS_PER_TOKEN = 20
const UPLOAD_BYTES_PER_TOKEN = 128 * 1024 * 1024
const GLOBAL_STREAM_BUFFER = 500
const SSE_KEEPALIVE_MS = 20_000
const BOT_FIELDS = new Set(['name', 'role', 'instructions', 'color', 'avatar', 'model', 'effort'])
const GROUP_FIELDS = new Set(['name', 'notice', 'mode', 'members', 'add', 'remove', 'avatar'])

function safeFields(body, allowed) {
  for (const field of Object.keys(body)) {
    if (!allowed.has(field)) throw httpError(400, 'api/invalid-field', `Field "${field}" cannot be changed through the API`)
  }
  return { ...body }
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

function validateCursor(cursor) {
  if (cursor === undefined) return cursor
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
    || !Number.isSafeInteger(cursor.part) || cursor.part < 0
    || Object.keys(cursor).some(key => !['part', 'beforeSeq'].includes(key))
    || (cursor.beforeSeq !== undefined && (!Number.isSafeInteger(cursor.beforeSeq) || cursor.beforeSeq < 0))) {
    throw httpError(400, 'api/invalid', 'cursor must contain a non-negative integer part and optional beforeSeq')
  }
  return cursor
}

function parseCursor(raw) {
  if (raw === null) return undefined
  try { return validateCursor(JSON.parse(raw)) } catch {
    throw httpError(400, 'api/invalid', 'Invalid cursor')
  }
}

function decodePath(value) {
  try { return decodeURIComponent(value) } catch {
    throw httpError(400, 'api/invalid', 'Invalid path escape')
  }
}

const monthKey = (ms = Date.now()) => {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function httpError(status, code, message, details = {}) {
  return Object.assign(new Error(message), { status, code, details })
}

async function avatarMutation(change) {
  try {
    return await change()
  } catch (error) {
    if (error instanceof AvatarValidationError) throw httpError(400, 'api/invalid-avatar', error.message)
    throw error
  }
}

export function sendJson(res, status, data, extraHeaders = {}) {
  if (res.writableEnded) return
  const payload = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(payload)
}

export function sendError(res, error, extraHeaders = {}) {
  const status = Number.isInteger(error?.status) ? error.status
    : error?.code === 'bot/not-found' || error?.code === 'room/not-found' ? 404
    : error?.code === 'bot/read-only' ? 503
    : error?.code === 'bot/invalid' ? 400
    : error?.code === 'bot/forbidden' || error?.code === 'bot/refused' ? 403
    : error?.code === 'bot/stale' ? 409
    : 500
  const code = typeof error?.code === 'string' ? error.code : 'api/internal-error'
  const message = error?.message ?? 'Internal server error'
  const details = error?.details && typeof error.details === 'object' ? error.details : {}
  const headers = { ...extraHeaders }
  if (status === 429 && Number.isFinite(details.retryAfterMs)) {
    headers['retry-after'] = String(Math.max(1, Math.ceil(details.retryAfterMs / 1_000)))
  }
  sendJson(res, status, { error: { code, message, details } }, headers)
}

export async function readBodyBuffer(req, maxBytes) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw httpError(413, 'api/payload-too-large', `Request body exceeds limit of ${maxBytes} bytes`)
  }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) {
      throw httpError(413, 'api/payload-too-large', `Request body exceeds limit of ${maxBytes} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody(req, maxBytes = JSON_BODY_LIMIT) {
  const buf = await readBodyBuffer(req, maxBytes)
  if (buf.length === 0) return {}
  try {
    const parsed = JSON.parse(buf.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw httpError(400, 'api/invalid-json', 'Request body must be a JSON object')
    }
    return parsed
  } catch (error) {
    if (error?.status) throw error
    throw httpError(400, 'api/invalid-json', 'Malformed JSON request body')
  }
}

// Stable deterministic id for a memory entry so PATCH/DELETE /memory/:entryId works cleanly.
function memoryEntryId(scope, topic, text) {
  return `mem_${createHash('sha256').update(`${scope}\0${topic ?? ''}\0${text}`).digest('hex').slice(0, 16)}`
}

function normalizeMemoryEntries(view, wantedScope) {
  const list = Array.isArray(view?.entries) ? view.entries : []
  return list
    .filter(entry => !wantedScope || entry.scope === wantedScope)
    .map(entry => ({
      id: memoryEntryId(entry.scope, entry.topic ?? null, entry.text),
      scope: entry.scope,
      topic: entry.topic ?? null,
      text: entry.text,
      pinned: entry.pinned === true,
      ...(entry.added ? { added: entry.added } : {}),
    }))
}

export function createApiRoutes(rt, { auth, runs, sseClients }) {
  const { ctx, state } = rt
  const uploadsDir = join(rt.home, 'api-uploads')
  const uploads = new Map() // uploadId -> { id, path, name, mime, size, tokenId, createdAt }
  const dedupeEvents = new Map()
  const globalBuffer = [] // { id, event, data, targetKind, targetId }
  let globalSeq = 0
  const globalSubscribers = new Set()

  const writes = () => rt.readOnly?.() === undefined

  // Clean up expired temporary uploads periodically.
  const uploadCleaner = setInterval(() => {
    const cutoff = Date.now() - UPLOAD_TTL_MS
    for (const [id, entry] of uploads) {
      if (entry.createdAt < cutoff) {
        uploads.delete(id)
        try { rmSync(entry.path, { force: true }) } catch {}
      }
    }
  }, 5 * 60_000)
  uploadCleaner.unref?.()

  function emitGlobal(event, data) {
    globalSeq += 1
    const id = `ev_${globalSeq}`
    const targetKind = data?.target?.kind ?? (data?.botId ? 'bot' : data?.roomId ? 'group' : null)
    const targetId = data?.target?.id ?? data?.botId ?? data?.roomId ?? null
    const record = { id, event, data, targetKind, targetId }
    globalBuffer.push(record)
    if (globalBuffer.length > GLOBAL_STREAM_BUFFER) globalBuffer.shift()
    for (const sub of globalSubscribers) {
      try { sub(record) } catch { /* isolate */ }
    }
  }
  rt.apiEmitGlobal = emitGlobal

  // Bridge live feed notices and room updates into the global API SSE stream on demand
  // so idle hosts keep zero active feed taps.
  let offFeed = null
  const syncFeedTap = () => {
    if (globalSubscribers.size > 0 && offFeed === null) {
      offFeed = rt.feedTap?.((event, data) => {
        if (event === 'notice' && data) {
          emitGlobal(`notice.${data.kind ?? 'info'}`, {
            botId: data.botId ?? null,
            roomId: data.roomId ?? null,
            name: data.name ?? null,
            text: data.text ?? '',
            time: data.time ?? Date.now(),
          })
        } else if (event === 'room' && data?.roomId) {
          emitGlobal('group.updated', { roomId: data.roomId })
        }
      }) ?? null
    } else if (globalSubscribers.size === 0 && offFeed !== null) {
      offFeed()
      offFeed = null
    }
  }

  async function checkModelEngine(patch, currentEngine) {
    if (patch.model === undefined) return
    const model = patch.model === null || patch.model === '' ? null : await rt.resolveModel(patch.model)
    if ((model === null ? 'model' : rt.engineOf(model)) !== currentEngine) {
      throw httpError(400, 'api/invalid-field', 'Field "model" cannot change the Bot engine through the API')
    }
    patch.model = model
  }

  function requireScope(principal, scope) {
    if (!principal.hasScope(scope)) {
      throw httpError(403, 'api/scope-required', `This endpoint requires the "${scope}" scope`)
    }
  }

  function botSummary(bot) {
    const sid = rt.chatOf(bot.id)
    const tasks = rt.taskViewOf?.(bot) ?? []
    const activeTasks = tasks.filter(task => task.status === 'running' || task.status === 'waiting_approval' || task.status === 'waiting_work')
    const busy = (sid !== undefined && rt.live.get(sid)?.turn !== undefined) || activeTasks.length > 0
    return {
      id: bot.id,
      name: bot.name,
      role: bot.role ?? '',
      isMain: rt.isMain(bot.id),
      private: bot.private === true,
      engine: rt.localAgentBadge?.(bot.model ?? bot.appliedModel) ?? 'dsh',
      model: bot.model ?? bot.appliedModel ?? rt.cachedDefault?.() ?? null,
      busy,
      activeTaskCount: activeTasks.length,
      sessionId: sid ?? null,
    }
  }

  function groupSummary(room, principal) {
    const visibleMembers = (room.members ?? []).filter(id => {
      const bot = rt.botOf(id)
      return bot !== undefined && (bot.private !== true || principal.canAccessBot(id))
    })
    const busy = rt.roomActive?.(room.id) === true || (rt.roomWorkView?.()[room.id] ?? []).length > 0
    return {
      id: room.id,
      name: room.name,
      members: visibleMembers.map(id => ({ id, name: rt.botOf(id)?.name ?? id })),
      adminId: room.admin ?? null,
      mode: room.mode ?? 'everyone',
      workDir: room.workDir ?? null,
      goal: room.goal ? { id: room.goal.id, status: room.goal.status, title: room.goal.title ?? '' } : null,
      busy,
    }
  }

  async function resolveAttachments(principal, rawAttachments) {
    if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return []
    const resolved = []
    for (const item of rawAttachments) {
      const uploadId = typeof item === 'string' ? item : String(item?.uploadId ?? '')
      const staged = uploads.get(uploadId)
      if (staged === undefined || staged.tokenId !== principal.keyId) {
        throw httpError(400, 'api/invalid-attachment', `Unknown or expired uploadId "${uploadId}"`)
      }
      const bytes = readFileSync(staged.path)
      if (IMAGE_MIMES.has(staged.mime)) {
        resolved.push({
          id: uploadId,
          name: staged.name,
          block: { type: 'image', mediaType: staged.mime, data: bytes.toString('base64') },
        })
      } else {
        const attachmentSvc = ctx.get?.('attachments')
        if (attachmentSvc?.saveFile) {
          const saved = await attachmentSvc.saveFile({ data: new Uint8Array(bytes), name: staged.name })
          resolved.push({
            id: uploadId,
            name: staged.name,
            block: { type: 'file', attachment: saved },
          })
        } else {
          // Fallback: inline text note for small plain-text files when host has no attachment store.
          resolved.push({
            id: uploadId,
            name: staged.name,
            block: { type: 'text', text: `[Attached file: ${staged.name} (${staged.size} bytes)]` },
          })
        }
      }
    }
    return resolved
  }

  // Resolve a Bot by ID or exact name (within the caller's authorized scope).
  function findAuthorizedBot(principal, ref) {
    const direct = rt.botOf(ref)
    if (direct !== undefined) {
      const access = principal.assertBotAccess(direct.id)
      if (!access.ok) throw httpError(access.status, access.code, access.message)
      return direct
    }
    const named = Object.values(state.bots).find(bot => bot.name === ref && principal.canAccessBot(bot.id))
    if (named !== undefined) return named
    throw httpError(404, 'bot/not-found', 'Bot not found')
  }

  function findAuthorizedGroup(principal, ref) {
    const direct = rt.roomOf(ref)
    if (direct !== undefined) {
      const access = principal.assertRoomAccess(direct.id)
      if (!access.ok) throw httpError(access.status, access.code, access.message)
      return direct
    }
    const named = Object.values(state.rooms).find(room => room.name === ref && principal.canAccessRoom(room.id))
    if (named !== undefined) return named
    throw httpError(404, 'room/not-found', 'Group not found')
  }

  // Shared business service used by REST, MCP, and OpenAI compat layers.
  const service = {
    health(principal) {
      const cursor = rt.noticeCursor?.() ?? {}
      return {
        ok: true,
        apiVersion: 'v1',
        pluginVersion: PKG.version,
        holdsLock: rt.readOnly?.() === undefined,
        boot: cursor.boot ?? null,
        tokenId: principal.keyId,
        uptimeSec: Math.round(process.uptime()),
      }
    },

    capabilities(principal) {
      return {
        apiVersion: 'v1',
        pluginVersion: PKG.version,
        capabilities: [
          'bots',
          'groups',
          'runs',
          'runs.chat',
          'runs.task',
          'runs.sse',
          'runs.waiting_human',
          'uploads',
          'files',
          'memory',
          'events.stream',
          'events.ingest',
          'mcp.streamable_http',
          ...(auth.getConfig().openaiCompat ? ['compat.openai'] : []),
        ],
        token: {
          keyId: principal.keyId,
          name: principal.name,
          scopes: principal.scopes,
          targetScope: principal.targetScope,
        },
      }
    },

    listBots(principal) {
      requireScope(principal, 'read')
      const bots = Object.values(state.bots)
        .filter(bot => principal.canAccessBot(bot.id))
        .map(botSummary)
      return { bots }
    },

    getBot(principal, botId) {
      requireScope(principal, 'read')
      const bot = findAuthorizedBot(principal, botId)
      const sid = rt.chatOf(bot.id)
      const approvals = (rt.approvalsView?.() ?? []).filter(entry => entry.botId === bot.id)
      const pendingActions = []
      for (const a of approvals) {
        pendingActions.push({ kind: 'approval', actionId: a.id, sessionId: a.sessionId, summary: `${a.tool}: ${a.reason}` })
      }
      if (sid && rt.own(state.questions, sid)) {
        const q = state.questions[sid]
        pendingActions.push({ kind: 'question', actionId: q.id, sessionId: sid, summary: String(q.question ?? q.title ?? '') })
      }
      if (sid && rt.own(state.views, sid)) {
        const v = state.views[sid]
        pendingActions.push({ kind: 'view', actionId: v.id, sessionId: sid, summary: String(v.title ?? '') })
      }
      if (sid && rt.own(state.secretRequests, sid)) {
        const s = state.secretRequests[sid]
        pendingActions.push({ kind: 'secret', actionId: String(s.id ?? s.name ?? sid), sessionId: sid, summary: String(s.name ?? '') })
      }
      return {
        ...botSummary(bot),
        ...(principal.hasScope('team:manage') ? { instructions: bot.instructions ?? '' } : {}),
        tasks: rt.taskViewOf?.(bot) ?? [],
        pendingActions,
      }
    },

    listGroups(principal) {
      requireScope(principal, 'read')
      const groups = Object.values(state.rooms)
        .filter(room => principal.canAccessRoom(room.id))
        .map(room => groupSummary(room, principal))
      return { groups }
    },

    getGroup(principal, groupId) {
      requireScope(principal, 'read')
      const room = findAuthorizedGroup(principal, groupId)
      const working = rt.roomWorkView?.()[room.id] ?? []
      return {
        ...groupSummary(room, principal),
        notice: room.notice ?? '',
        working,
        tasks: openTasksOf(room),
        todos: Array.isArray(room.todos) ? room.todos : [],
      }
    },

    async sendToBot(principal, botId, body, { idempotencyKey } = {}) {
      requireScope(principal, 'message')
      const bot = findAuthorizedBot(principal, botId)
      const attachments = await resolveAttachments(principal, body.attachments)
      const mode = body.mode === 'task' ? 'task' : 'chat'
      const { run, replayed } = await runs.startBotRun({
        principal,
        bot,
        text: body.text ?? '',
        mode,
        title: body.title,
        attachments,
        idempotencyKey,
      })
      const waitSec = Number(body.wait ?? body.waitSeconds ?? 0)
      const finalRun = !replayed && waitSec > 0 ? await runs.waitForRun(run.runId, waitSec) : run
      return { run: finalRun, replayed }
    },

    async sendToGroup(principal, groupId, body, { idempotencyKey } = {}) {
      requireScope(principal, 'message')
      const room = findAuthorizedGroup(principal, groupId)
      const attachments = await resolveAttachments(principal, body.attachments)
      const { run, replayed } = await runs.startGroupRun({
        principal,
        room,
        text: body.text ?? '',
        mentions: Array.isArray(body.mentions) ? body.mentions : [],
        attachments,
        idempotencyKey,
      })
      const waitSec = Number(body.wait ?? body.waitSeconds ?? 0)
      const finalRun = !replayed && waitSec > 0 ? await runs.waitForRun(run.runId, waitSec) : run
      return { run: finalRun, replayed }
    },

    listRuns(principal, query = {}) {
      requireScope(principal, 'read')
      return { runs: runs.listRunsForPrincipal(principal, query) }
    },

    getRun(principal, runId) {
      requireScope(principal, 'read')
      const found = runs.getRunForPrincipal(runId, principal)
      if (!found.ok) throw httpError(found.status, found.code, found.message)
      return found.run
    },

    async cancelRun(principal, runId) {
      requireScope(principal, 'message')
      const result = await runs.cancelRun(runId, principal)
      if (!result.ok) throw httpError(result.status, result.code, result.message)
      return result.run
    },

    async respondRun(principal, runId, body) {
      requireScope(principal, 'card:respond')
      const result = await runs.respondToRun(runId, principal, body)
      if (!result.ok) throw httpError(result.status, result.code, result.message)
      return result.run
    },

    async readBotHistory(principal, botId, { cursor, limit } = {}) {
      requireScope(principal, 'read')
      const bot = findAuthorizedBot(principal, botId)
      const page = await rt.chatPage(bot.id, validateCursor(cursor), false)
      const cap = Math.max(1, Math.min(200, Number(limit) || 60))
      const items = (page.items ?? []).slice(-cap).map(item => {
        const out = { ...item }
        if (Array.isArray(item.imageRefs)) {
          out.files = item.imageRefs.map(ref => ({
            fileRef: runs.registerFile({
              kind: 'image',
              sessionId: item.sessionId ?? rt.chatOf(bot.id),
              botId: bot.id,
              attachmentId: ref.attachmentId,
              name: ref.name ?? 'image',
              mime: ref.mime ?? 'image/png',
            }),
            name: ref.name ?? 'image',
            mime: ref.mime ?? 'image/png',
          }))
        }
        return out
      })
      return { botId: bot.id, items, cursor: page.cursor ?? null }
    },

    async readGroupHistory(principal, groupId, { cursor, limit } = {}) {
      requireScope(principal, 'read')
      const room = findAuthorizedGroup(principal, groupId)
      const page = await rt.mobileEndpoint('room-chat', { roomId: room.id, cursor: validateCursor(cursor) })
      const cap = Math.max(1, Math.min(200, Number(limit) || 60))
      const items = (page.items ?? []).slice(-cap)
      return {
        groupId: room.id,
        items,
        cursor: page.cursor ?? null,
        running: page.running === true,
        speaking: page.speaking ?? null,
      }
    },

    async readMemory(principal, { kind, targetId, q, scope }) {
      requireScope(principal, 'memory:read')
      if (rt.memoryEnabled === false) return { entries: [], enabled: false }
      let body
      let defaultScope
      if (kind === 'bot') {
        const bot = findAuthorizedBot(principal, targetId)
        body = { botId: bot.id }
        defaultScope = scope || 'own'
      } else if (kind === 'group') {
        const room = findAuthorizedGroup(principal, targetId)
        body = { roomId: room.id }
        defaultScope = scope || 'group'
      } else {
        // Team memory: pick any authorized Bot to view the shared team scope.
        const anyBot = Object.values(state.bots).find(bot => principal.canAccessBot(bot.id))
        if (anyBot === undefined) return { entries: [] }
        body = { botId: anyBot.id }
        defaultScope = 'team'
      }
      const view = await rt.memoryEndpoint('memory-view', body)
      let entries = normalizeMemoryEntries(view, defaultScope === 'all' ? undefined : defaultScope)
      if (typeof q === 'string' && q.trim() !== '') {
        const needle = q.trim().toLowerCase()
        entries = entries.filter(entry =>
          entry.text.toLowerCase().includes(needle)
          || (entry.topic && entry.topic.toLowerCase().includes(needle)))
      }
      return { entries }
    },

    async addMemory(principal, { kind, targetId, text, topic, scope }) {
      requireScope(principal, 'memory:write')
      if (!writes()) throw httpError(503, 'bot/read-only', rt.readOnly() ?? 'Host is read-only')
      let target
      let resolvedScope
      if (kind === 'bot') {
        const bot = findAuthorizedBot(principal, targetId)
        target = { botId: bot.id }
        resolvedScope = scope === 'team' ? 'team' : 'own'
      } else if (kind === 'group') {
        const room = findAuthorizedGroup(principal, targetId)
        target = { roomId: room.id }
        resolvedScope = scope === 'team' ? 'team' : 'group'
      } else {
        const anyBot = Object.values(state.bots).find(bot => principal.canAccessBot(bot.id))
        if (anyBot === undefined) throw httpError(403, 'api/target-forbidden', 'No authorized Bot available for team memory')
        target = { botId: anyBot.id }
        resolvedScope = 'team'
      }
      const view = await rt.memoryAdd({ ...target, scope: resolvedScope, topic, text })
      const entries = normalizeMemoryEntries(view, resolvedScope)
      const created = entries.find(entry => entry.text === String(text ?? '').trim() && (entry.topic ?? null) === (topic ?? null)) ?? entries.at(-1)
      return { entry: created ?? null, entries }
    },

    async editMemory(principal, { kind, targetId, entryId, text, scope }) {
      requireScope(principal, 'memory:write')
      if (!writes()) throw httpError(503, 'bot/read-only', rt.readOnly() ?? 'Host is read-only')
      const { entries } = await service.readMemory(principal, { kind, targetId, scope: scope || 'all' })
      const match = entries.find(entry => entry.id === entryId)
      if (match === undefined) throw httpError(404, 'memory/not-found', 'Memory entry not found')
      const target = kind === 'group'
        ? { roomId: findAuthorizedGroup(principal, targetId).id }
        : kind === 'bot'
          ? { botId: findAuthorizedBot(principal, targetId).id }
          : { botId: Object.values(state.bots).find(bot => principal.canAccessBot(bot.id))?.id }
      const view = await rt.memoryEdit({ ...target, scope: match.scope, topic: match.topic, text: match.text, next: text })
      const updated = normalizeMemoryEntries(view, match.scope)
      return {
        entry: updated.find(entry => entry.text === String(text ?? '').trim() && entry.topic === match.topic) ?? null,
      }
    },

    async deleteMemory(principal, { kind, targetId, entryId, scope }) {
      requireScope(principal, 'memory:write')
      if (!writes()) throw httpError(503, 'bot/read-only', rt.readOnly() ?? 'Host is read-only')
      const { entries } = await service.readMemory(principal, { kind, targetId, scope: scope || 'all' })
      const match = entries.find(entry => entry.id === entryId)
      if (match === undefined) throw httpError(404, 'memory/not-found', 'Memory entry not found')
      const target = kind === 'group'
        ? { roomId: findAuthorizedGroup(principal, targetId).id }
        : kind === 'bot'
          ? { botId: findAuthorizedBot(principal, targetId).id }
          : { botId: Object.values(state.bots).find(bot => principal.canAccessBot(bot.id))?.id }
      await rt.memoryEndpoint('memory-forget', { ...target, scope: match.scope, topic: match.topic, text: match.text })
      return { deleted: true, id: entryId }
    },

    async ingestEvent(principal, body, { idempotencyKey } = {}) {
      requireScope(principal, 'event:ingest')
      if (!writes()) throw httpError(503, 'bot/read-only', rt.readOnly() ?? 'Host is read-only')
      if (!body || typeof body !== 'object') throw httpError(400, 'api/invalid', 'Event body must be a JSON object')

      const source = String(body.source ?? body.sourceId ?? `api:${principal.keyId}`).trim().slice(0, 80)
      const type = String(body.type ?? body.eventType ?? 'external.event').trim().slice(0, 120)
      const title = String(body.title ?? '').trim().slice(0, 200)
      const summary = String(body.summary ?? title).trim().slice(0, 500)
      const eventId = String(body.eventId ?? idempotencyKey ?? '').trim().slice(0, 200)
      const threadKey = String(body.threadKey ?? '').trim().slice(0, 160)
      const dryRun = body.dryRun === true

      if (summary === '' && body.payload === undefined && !body.body) {
        throw httpError(400, 'api/invalid', 'Event requires title, summary, body, or payload')
      }

      // Authorize explicit target if provided; private Bots always 404 when unauthorized.
      let privateBotId
      let target = null
      const rawTarget = body.target
      if (rawTarget && typeof rawTarget === 'object') {
        if (rawTarget.kind === 'bot' && rawTarget.id) {
          const bot = findAuthorizedBot(principal, String(rawTarget.id))
          if (bot.private === true) privateBotId = bot.id
          target = { kind: 'bot', id: bot.id }
        } else if ((rawTarget.kind === 'group' || rawTarget.kind === 'room') && rawTarget.id) {
          const room = findAuthorizedGroup(principal, String(rawTarget.id))
          target = { kind: 'group', id: room.id }
        }
      } else if (typeof body.botId === 'string' && body.botId !== '') {
        const bot = findAuthorizedBot(principal, body.botId)
        if (bot.private === true) privateBotId = bot.id
        target = { kind: 'bot', id: bot.id }
      } else if (typeof body.roomId === 'string' && body.roomId !== '') {
        const room = findAuthorizedGroup(principal, body.roomId)
        target = { kind: 'group', id: room.id }
      }

      // If the v0.4.0 event-driven router is installed on this host, delegate directly to it.
      if (typeof rt.eventsIngest === 'function') {
        const delegated = await rt.eventsIngest({
          ...body,
          sourceId: source,
          sourceName: principal.name,
          eventType: type,
          eventId: eventId || undefined,
          threadKey,
          summary,
          dryRun,
          ...(target?.kind === 'bot' ? { botId: target.id } : {}),
          ...(target?.kind === 'group' ? { roomId: target.id } : {}),
        }, { keyId: principal.keyId, tokenName: principal.name, principal })
        return {
          ledgerEventId: delegated?.event?.id ?? delegated?.ledgerEventId ?? null,
          status: delegated?.status ?? (dryRun ? 'dry_run' : 'accepted'),
          matchedSubscriptions: delegated?.matchedSubscriptions ?? [],
        }
      }

      // Standalone ledger persistence (exact compatible schema with v0.4.0 event ledger).
      const now = Date.now()
      const book = privateBotId
        ? `events-priv-${privateBotId}-${monthKey(now)}`
        : `events-${monthKey(now)}`
      const dedupeKey = eventId !== '' ? JSON.stringify([principal.keyId, book, source, eventId]) : ''
      if (dedupeKey !== '' && dedupeEvents.has(dedupeKey)) {
        return {
          ledgerEventId: dedupeEvents.get(dedupeKey),
          status: 'duplicate',
          matchedSubscriptions: [],
        }
      }

      if (dedupeKey !== '') {
        const prior = rt.ledger.records(book).find(r => r?.recordKind === 'event' && r.dedupeKey === dedupeKey)
        if (prior !== undefined) {
          dedupeEvents.set(dedupeKey, prior.id)
          return { ledgerEventId: prior.id, status: 'duplicate', matchedSubscriptions: [] }
        }
      }

      const ledgerEventId = `ev_${randomBytes(6).toString('hex')}`
      const record = {
        recordKind: 'event',
        seq: rt.ledger.lastSeq(book) + 1,
        id: ledgerEventId,
        time: now,
        source: { kind: 'api', id: source, name: principal.name, tokenId: principal.keyId },
        trust: 'external_untrusted',
        threadKey,
        entityKey: threadKey || eventId || ledgerEventId,
        eventType: type,
        dedupeKey,
        title,
        summary,
        body: typeof body.body === 'string' ? body.body : (body.payload !== undefined ? JSON.stringify(body.payload) : ''),
        ...(body.payload !== undefined ? { payload: body.payload } : {}),
        ...(target ? { target } : {}),
        ...(privateBotId ? { privateBotId } : {}),
        dryRun,
      }
      rt.ledger.append(book, record)
      await rt.ledger.written(book)
      if (dedupeKey !== '') {
        dedupeEvents.set(dedupeKey, ledgerEventId)
        while (dedupeEvents.size > 4_000) dedupeEvents.delete(dedupeEvents.keys().next().value)
      }
      emitGlobal('external.event', {
        ledgerEventId,
        source,
        type,
        title,
        summary,
        target,
        dryRun,
      })
      return {
        ledgerEventId,
        status: dryRun ? 'dry_run' : 'accepted',
        matchedSubscriptions: [],
      }
    },

    async createBot(principal, body) {
      requireScope(principal, 'team:manage')
      if (!writes()) throw httpError(503, 'bot/read-only', rt.readOnly() ?? 'Host is read-only')
      const patch = safeFields(body, BOT_FIELDS)
      await checkModelEngine(patch, 'model')
      await rt.bootstrap()
      const bot = await avatarMutation(() => rt.createBot(patch, API_ACTOR))
      return botSummary(bot)
    },

    async updateBot(principal, botId, body) {
      requireScope(principal, 'team:manage')
      if (!writes()) throw httpError(503, 'bot/read-only', rt.readOnly() ?? 'Host is read-only')
      const bot = findAuthorizedBot(principal, botId)
      const patch = safeFields(body, BOT_FIELDS)
      await checkModelEngine(patch, rt.engineOfBot(bot) ?? 'model')
      const updated = await avatarMutation(() => rt.updateBot(bot.id, patch, API_ACTOR))
      return botSummary(updated)
    },

    async createGroup(principal, body) {
      requireScope(principal, 'team:manage')
      if (!writes()) throw httpError(503, 'bot/read-only', rt.readOnly() ?? 'Host is read-only')
      const members = Array.isArray(body.members) ? body.members.map(String) : []
      for (const memberId of members) {
        const bot = findAuthorizedBot(principal, memberId)
        if (bot.private === true) throw httpError(403, 'api/forbidden', 'Private Bots cannot join groups')
      }
      const room = await avatarMutation(() => rt.createRoom({
        members,
        name: body.name,
        avatar: body.avatar,
        section: body.section,
        sectionId: body.sectionId,
        ...(typeof body.admin === 'string' ? { admin: body.admin } : {}),
      }))
      return groupSummary(room, principal)
    },

    async updateGroup(principal, groupId, body) {
      requireScope(principal, 'team:manage')
      if (!writes()) throw httpError(503, 'bot/read-only', rt.readOnly() ?? 'Host is read-only')
      const room = findAuthorizedGroup(principal, groupId)
      const patch = safeFields(body, GROUP_FIELDS)
      for (const field of ['members', 'add', 'remove']) {
        if (patch[field] === undefined) continue
        if (!Array.isArray(patch[field]) || patch[field].some(id => typeof id !== 'string' || id.trim() === '')) {
          throw httpError(400, 'api/invalid-field', `Field "${field}" must be an array of Bot IDs`)
        }
        patch[field] = patch[field].map(id => {
          const bot = findAuthorizedBot(principal, id)
          if (field !== 'remove' && bot.private === true) throw httpError(403, 'api/forbidden', 'Private Bots cannot join groups')
          return bot.id
        })
      }
      if (patch.members !== undefined) {
        patch.members = [...new Set([...patch.members, ...(room.members ?? []).filter(id => !principal.canAccessBot(id))])]
      }
      const { room: updated } = await avatarMutation(() => rt.updateRoom(room.id, patch, API_ACTOR))
      return groupSummary(updated, principal)
    },

    async controlGroupGoal(principal, groupId, body) {
      requireScope(principal, 'team:manage')
      if (!writes()) throw httpError(503, 'bot/read-only', rt.readOnly() ?? 'Host is read-only')
      const room = findAuthorizedGroup(principal, groupId)
      const fields = body.action === 'draft' ? ['action', 'text'] : ['action', 'goalId', ...(body.action === 'pause' ? ['stopWork'] : [])]
      const patch = safeFields(body, new Set(fields))
      if (!['draft', 'pause', 'resume', 'stop', 'clear'].includes(patch.action)
        || (patch.action === 'draft' ? typeof patch.text !== 'string' || !patch.text.trim() : typeof patch.goalId !== 'string' || !patch.goalId.trim())
        || (patch.stopWork !== undefined && typeof patch.stopWork !== 'boolean')) {
        throw httpError(400, 'api/invalid', 'Invalid goal action, text, goalId, or stopWork')
      }
      if (body.action === 'draft' && typeof body.text === 'string') {
        // The token holder's words are no owner's words: the draft travels
        // tagged 'api' through the relay into the group ledger, so the memory
        // review's external filter treats it like any API input (viaOf's tag).
        const res = await rt.goalDraft(room.id, body.text, { via: 'api' })
        if (res?.error) throw httpError(400, res.code ?? 'bot/refused', res.error)
      } else {
        // Thread `{ via: 'api' }` on goalControl too so API `resume` relays carry the
        // external channel marker in the group ledger and never trigger memory review
        // as if the owner had posted in the group.
        const res = await rt.goalControl(room.id, patch, { via: 'api' })
        if (res?.error) throw httpError(400, res.code ?? 'bot/refused', res.error)
      }
      return groupSummary(rt.roomOf(room.id), principal)
    },
  }

  function openSse(res, req, principal) {
    const closers = new Set()
    let authTimer
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    const writeEvent = (event, data, id) => {
      if (principal?.isCurrent?.() === false) { client.close(); return }
      if (res.writableEnded) return
      const lines = []
      if (id !== undefined) lines.push(`id: ${id}`)
      lines.push(`event: ${event}`)
      lines.push(`data: ${JSON.stringify(data)}`)
      res.write(`${lines.join('\n')}\n\n`)
    }
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n')
    }, SSE_KEEPALIVE_MS)
    keepalive.unref?.()
    const client = {
      res,
      close: () => {
        clearInterval(keepalive)
        sseClients.delete(client)
        if (!res.writableEnded) {
          try { res.write('event: shutdown\ndata: {"reason":"server_shutdown"}\n\n') } catch {}
          try { res.end() } catch {}
        }
        cleanup()
      },
    }
    sseClients.add(client)
    const cleanup = () => {
      clearInterval(keepalive)
      clearInterval(authTimer)
      sseClients.delete(client)
      for (const close of closers) close()
      closers.clear()
    }
    authTimer = setInterval(() => {
      if (principal?.isCurrent?.() === false) client.close()
    }, 1_000)
    authTimer.unref?.()
    req.on('close', cleanup)
    return { writeEvent, cleanup, onClose: fn => closers.add(fn) }
  }

  async function handleUpload(req, res, principal) {
    requireScope(principal, 'message')
    if (!writes()) throw httpError(503, 'bot/read-only', rt.readOnly() ?? 'Host is read-only')
    const checkCapacity = (size = 0) => {
      let count = 0
      let total = 0
      for (const [id, entry] of uploads) {
        if (Date.now() - entry.createdAt >= UPLOAD_TTL_MS) {
          uploads.delete(id)
          try { rmSync(entry.path, { force: true }) } catch {}
        } else if (entry.tokenId === principal.keyId) {
          count += 1
          total += entry.size
        }
      }
      if (count >= UPLOADS_PER_TOKEN) throw httpError(429, 'api/upload-limit', 'A token may stage at most 20 live uploads', { retryAfterMs: UPLOAD_TTL_MS })
      if (total + size > UPLOAD_BYTES_PER_TOKEN) throw httpError(413, 'api/upload-limit', 'A token may stage at most 128 MiB of live uploads')
    }
    checkCapacity()
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    let name = 'upload.bin'
    let mime = 'application/octet-stream'
    let bytes

    if (contentType.includes('application/json')) {
      const body = await readJsonBody(req, UPLOAD_BODY_LIMIT)
      if (typeof body.data !== 'string' || body.data === '') {
        throw httpError(400, 'api/invalid', 'Base64 data is required')
      }
      name = String(body.name ?? 'upload.bin').replace(/[/\\]/g, '_').slice(0, 120) || 'upload.bin'
      mime = String(body.mime ?? body.mediaType ?? 'application/octet-stream').slice(0, 100)
      bytes = Buffer.from(body.data, 'base64')
      if (bytes.length > UPLOAD_BODY_LIMIT) {
        throw httpError(413, 'api/payload-too-large', 'Upload exceeds 32 MiB limit')
      }
    } else {
      bytes = await readBodyBuffer(req, UPLOAD_BODY_LIMIT)
      if (bytes.length === 0) throw httpError(400, 'api/invalid', 'Empty upload body')
      const headerName = String(req.headers['x-filename'] ?? 'upload.bin')
      name = headerName.replace(/[/\\]/g, '_').slice(0, 120) || 'upload.bin'
      mime = contentType.split(';')[0].trim() || 'application/octet-stream'
    }

    checkCapacity(bytes.length)
    mime = mimeOf(bytes) ?? 'application/octet-stream'
    const uploadId = `upl_${randomBytes(8).toString('hex')}`
    mkdirSync(uploadsDir, { recursive: true })
    const filePath = join(uploadsDir, uploadId)
    writeFileSync(filePath, bytes, { mode: 0o600 })
    uploads.set(uploadId, { id: uploadId, path: filePath, name, mime, size: bytes.length, tokenId: principal.keyId, createdAt: Date.now() })
    sendJson(res, 201, { uploadId, name, mime, size: bytes.length })
  }

  async function handleFileDownload(res, principal, fileRef) {
    requireScope(principal, 'read')
    const desc = runs.getFileDescriptor(fileRef)
    if (desc === undefined) throw httpError(404, 'file/not-found', 'File not found')
    // Enforce authorization against the owning Bot or group before reading bytes.
    if (desc.botId !== undefined) {
      const access = principal.assertBotAccess(desc.botId)
      if (!access.ok) throw httpError(access.status, access.code, access.message)
    } else if (desc.roomId !== undefined) {
      const access = principal.assertRoomAccess(desc.roomId)
      if (!access.ok) throw httpError(access.status, access.code, access.message)
    } else {
      throw httpError(404, 'file/not-found', 'File not found')
    }

    let bytes
    let mime = desc.mime ?? 'application/octet-stream'
    let name = desc.name ?? 'file'
    if (desc.kind === 'image') {
      const img = await rt.mobileEndpoint('image', { sessionId: desc.sessionId, attachmentId: desc.attachmentId })
      bytes = Buffer.from(img.data, 'base64')
      mime = img.mime || mime
    } else if (desc.kind === 'presented') {
      const dl = await rt.mobileEndpoint('file-download', { sessionId: desc.sessionId, seq: desc.seq, index: desc.index })
      bytes = Buffer.from(dl.bytes, 'base64')
      mime = dl.mime || mime
      name = dl.name || name
    } else if (desc.kind === 'attachment') {
      const dl = await rt.mobileEndpoint('file-download', { sessionId: desc.sessionId, attachmentId: desc.attachmentId })
      bytes = Buffer.from(dl.bytes, 'base64')
      mime = dl.mime || mime
      name = dl.name || name
    } else {
      throw httpError(404, 'file/not-found', 'File not found')
    }

    const safeName = name.replace(/["\r\n]/g, '_')
    res.writeHead(200, {
      'content-type': mime,
      'content-length': bytes.length,
      'content-disposition': `attachment; filename="${safeName}"`,
      'cache-control': 'no-store',
    })
    res.end(bytes)
  }

  function streamRunSse(req, res, runId, principal) {
    const lastEventId = req.headers['last-event-id'] ? String(req.headers['last-event-id']) : undefined
    const { writeEvent, cleanup, onClose } = openSse(res, req, principal)
    const unsub = runs.subscribeRun(runId, (entry) => {
      writeEvent(entry.event, entry.data, entry.id)
      if (entry.event === 'run.completed' || entry.event === 'run.failed' || entry.event === 'run.stopped') {
        cleanup()
        if (!res.writableEnded) res.end()
      }
    }, { lastEventId })
    if (unsub === null) {
      cleanup()
      if (!res.writableEnded) res.end()
      return
    }
    onClose(unsub)
    if (res.writableEnded) unsub()
    req.on('close', () => unsub())
  }

  function streamGlobalEvents(req, res, principal, url) {
    requireScope(principal, 'read')
    const filterBot = url.searchParams.get('botId')
    const filterGroup = url.searchParams.get('groupId')
    const typesParam = url.searchParams.get('types')
    const filterTypes = typesParam ? new Set(typesParam.split(',').map(s => s.trim()).filter(Boolean)) : null
    const lastEventId = req.headers['last-event-id'] ? String(req.headers['last-event-id']) : null

    const visible = (record) => {
      if (filterTypes && !filterTypes.has(record.event)) return false
      if (record.targetKind === 'bot' && record.targetId) {
        if (!principal.canAccessBot(record.targetId)) return false
        if (filterBot && record.targetId !== filterBot) return false
        if (filterGroup) return false
      } else if (record.targetKind === 'group' && record.targetId) {
        if (!principal.canAccessRoom(record.targetId)) return false
        if (filterGroup && record.targetId !== filterGroup) return false
        if (filterBot) return false
      } else if (filterBot || filterGroup || principal.targetScope !== 'all_public') {
        return false
      }
      return true
    }

    const { writeEvent, onClose } = openSse(res, req, principal)
    writeEvent('hello', { apiVersion: 'v1', revision: state.revision })

    if (lastEventId) {
      const idx = globalBuffer.findIndex(item => item.id === lastEventId)
      if (idx >= 0) {
        for (let i = idx + 1; i < globalBuffer.length; i += 1) {
          if (visible(globalBuffer[i])) writeEvent(globalBuffer[i].event, globalBuffer[i].data, globalBuffer[i].id)
        }
      }
    }
    const listener = (record) => {
      if (visible(record)) writeEvent(record.event, record.data, record.id)
    }
    globalSubscribers.add(listener)
    onClose(() => { globalSubscribers.delete(listener); syncFeedTap() })
    syncFeedTap()
    req.on('close', () => {
      globalSubscribers.delete(listener)
      syncFeedTap()
    })
  }

  async function handleV1(req, res, url, principal, audit) {
    const method = req.method
    const path = url.pathname
    const segments = path.split('/').filter(Boolean) // ['v1', ...]
    if (segments[0] !== 'v1') return false

    const resource = segments[1]
    const id = segments[2] ? decodePath(segments[2]) : undefined
    const sub = segments[3]
    const subId = segments[4] ? decodePath(segments[4]) : undefined

    // Meta
    if (method === 'GET' && resource === 'health' && segments.length === 2) {
      sendJson(res, 200, service.health(principal))
      return true
    }
    if (method === 'GET' && resource === 'capabilities' && segments.length === 2) {
      sendJson(res, 200, service.capabilities(principal))
      return true
    }

    // Bots
    if (resource === 'bots') {
      if (method === 'GET' && segments.length === 2) {
        sendJson(res, 200, service.listBots(principal))
        return true
      }
      if (method === 'POST' && segments.length === 2) {
        const body = await readJsonBody(req)
        const bot = await service.createBot(principal, body)
        audit.targetKind = 'bot'
        audit.targetId = bot.id
        audit.targetName = bot.name
        sendJson(res, 201, bot)
        return true
      }
      if (method === 'GET' && segments.length === 3) {
        const bot = service.getBot(principal, id)
        audit.targetKind = 'bot'
        audit.targetId = bot.id
        audit.targetName = bot.name
        sendJson(res, 200, bot)
        return true
      }
      if (method === 'PATCH' && segments.length === 3) {
        const body = await readJsonBody(req)
        const bot = await service.updateBot(principal, id, body)
        audit.targetKind = 'bot'
        audit.targetId = bot.id
        audit.targetName = bot.name
        sendJson(res, 200, bot)
        return true
      }
      if (method === 'DELETE' && segments.length === 3) {
        throw httpError(405, 'api/method-not-allowed', 'Deleting Bots is only permitted on the computer')
      }
      if (sub === 'messages' && segments.length === 4) {
        if (method === 'GET') {
          const cursor = parseCursor(url.searchParams.get('cursor'))
          const data = await service.readBotHistory(principal, id, { cursor, limit: url.searchParams.get('limit') })
          audit.targetKind = 'bot'
          audit.targetId = data.botId
          sendJson(res, 200, data)
          return true
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          const idempotencyKey = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : undefined
          const wantsStream = body.stream === true || String(req.headers.accept ?? '').includes('text/event-stream')
          const { run } = await service.sendToBot(principal, id, wantsStream ? { ...body, wait: 0 } : body, { idempotencyKey })
          audit.targetKind = 'bot'
          audit.targetId = run.target.id
          audit.targetName = run.target.name
          audit.runId = run.runId
          if (wantsStream) {
            streamRunSse(req, res, run.runId, principal)
            return true
          }
          const done = run.status === 'completed' || run.status === 'failed' || run.status === 'stopped'
          sendJson(res, done ? 200 : 202, run)
          return true
        }
      }
      if (sub === 'memory') {
        if (method === 'GET' && segments.length === 4) {
          const data = await service.readMemory(principal, { kind: 'bot', targetId: id, q: url.searchParams.get('q'), scope: url.searchParams.get('scope') })
          audit.targetKind = 'bot'
          audit.targetId = id
          sendJson(res, 200, data)
          return true
        }
        if (method === 'POST' && segments.length === 4) {
          const body = await readJsonBody(req)
          const data = await service.addMemory(principal, { kind: 'bot', targetId: id, text: body.text, topic: body.topic, scope: body.scope })
          audit.targetKind = 'bot'
          audit.targetId = id
          sendJson(res, 201, data)
          return true
        }
        if (method === 'PATCH' && segments.length === 5) {
          const body = await readJsonBody(req)
          const data = await service.editMemory(principal, { kind: 'bot', targetId: id, entryId: subId, text: body.text, scope: body.scope })
          audit.targetKind = 'bot'
          audit.targetId = id
          sendJson(res, 200, data)
          return true
        }
        if (method === 'DELETE' && segments.length === 5) {
          const data = await service.deleteMemory(principal, { kind: 'bot', targetId: id, entryId: subId })
          audit.targetKind = 'bot'
          audit.targetId = id
          sendJson(res, 200, data)
          return true
        }
      }
    }

    // Groups
    if (resource === 'groups') {
      if (method === 'GET' && segments.length === 2) {
        sendJson(res, 200, service.listGroups(principal))
        return true
      }
      if (method === 'POST' && segments.length === 2) {
        const body = await readJsonBody(req)
        const group = await service.createGroup(principal, body)
        audit.targetKind = 'group'
        audit.targetId = group.id
        audit.targetName = group.name
        sendJson(res, 201, group)
        return true
      }
      if (method === 'GET' && segments.length === 3) {
        const group = service.getGroup(principal, id)
        audit.targetKind = 'group'
        audit.targetId = group.id
        audit.targetName = group.name
        sendJson(res, 200, group)
        return true
      }
      if (method === 'PATCH' && segments.length === 3) {
        const body = await readJsonBody(req)
        const group = await service.updateGroup(principal, id, body)
        audit.targetKind = 'group'
        audit.targetId = group.id
        audit.targetName = group.name
        sendJson(res, 200, group)
        return true
      }
      if (sub === 'messages' && segments.length === 4) {
        if (method === 'GET') {
          const cursor = parseCursor(url.searchParams.get('cursor'))
          const data = await service.readGroupHistory(principal, id, { cursor, limit: url.searchParams.get('limit') })
          audit.targetKind = 'group'
          audit.targetId = data.groupId
          sendJson(res, 200, data)
          return true
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          const idempotencyKey = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : undefined
          const wantsStream = body.stream === true || String(req.headers.accept ?? '').includes('text/event-stream')
          const { run } = await service.sendToGroup(principal, id, wantsStream ? { ...body, wait: 0 } : body, { idempotencyKey })
          audit.targetKind = 'group'
          audit.targetId = run.target.id
          audit.targetName = run.target.name
          audit.runId = run.runId
          if (wantsStream) {
            streamRunSse(req, res, run.runId, principal)
            return true
          }
          const done = run.status === 'completed' || run.status === 'failed' || run.status === 'stopped'
          sendJson(res, done ? 200 : 202, run)
          return true
        }
      }
      if (sub === 'goal' && method === 'POST' && segments.length === 4) {
        const body = await readJsonBody(req)
        const group = await service.controlGroupGoal(principal, id, body)
        audit.targetKind = 'group'
        audit.targetId = group.id
        sendJson(res, 200, group)
        return true
      }
      if (sub === 'memory') {
        if (method === 'GET' && segments.length === 4) {
          const data = await service.readMemory(principal, { kind: 'group', targetId: id, q: url.searchParams.get('q'), scope: url.searchParams.get('scope') })
          audit.targetKind = 'group'
          audit.targetId = id
          sendJson(res, 200, data)
          return true
        }
        if (method === 'POST' && segments.length === 4) {
          const body = await readJsonBody(req)
          const data = await service.addMemory(principal, { kind: 'group', targetId: id, text: body.text, topic: body.topic, scope: body.scope })
          audit.targetKind = 'group'
          audit.targetId = id
          sendJson(res, 201, data)
          return true
        }
        if (method === 'PATCH' && segments.length === 5) {
          const body = await readJsonBody(req)
          const data = await service.editMemory(principal, { kind: 'group', targetId: id, entryId: subId, text: body.text, scope: body.scope })
          audit.targetKind = 'group'
          audit.targetId = id
          sendJson(res, 200, data)
          return true
        }
        if (method === 'DELETE' && segments.length === 5) {
          const data = await service.deleteMemory(principal, { kind: 'group', targetId: id, entryId: subId })
          audit.targetKind = 'group'
          audit.targetId = id
          sendJson(res, 200, data)
          return true
        }
      }
    }

    // Team memory
    if (resource === 'team' && id === 'memory') {
      if (method === 'GET' && segments.length === 3) {
        sendJson(res, 200, await service.readMemory(principal, { kind: 'team', q: url.searchParams.get('q'), scope: 'team' }))
        return true
      }
      if (method === 'POST' && segments.length === 3) {
        const body = await readJsonBody(req)
        sendJson(res, 201, await service.addMemory(principal, { kind: 'team', text: body.text, topic: body.topic, scope: 'team' }))
        return true
      }
      if (method === 'PATCH' && segments.length === 4) {
        const body = await readJsonBody(req)
        sendJson(res, 200, await service.editMemory(principal, { kind: 'team', entryId: sub, text: body.text, scope: 'team' }))
        return true
      }
      if (method === 'DELETE' && segments.length === 4) {
        sendJson(res, 200, await service.deleteMemory(principal, { kind: 'team', entryId: sub, scope: 'team' }))
        return true
      }
    }

    // Runs
    if (resource === 'runs') {
      if (method === 'GET' && segments.length === 2) {
        sendJson(res, 200, service.listRuns(principal, {
          limit: url.searchParams.get('limit'),
          targetId: url.searchParams.get('targetId'),
          status: url.searchParams.get('status'),
        }))
        return true
      }
      if (method === 'GET' && segments.length === 3) {
        const run = service.getRun(principal, id)
        audit.runId = run.runId
        sendJson(res, 200, run)
        return true
      }
      if (method === 'GET' && sub === 'events' && segments.length === 4) {
        const run = service.getRun(principal, id)
        audit.runId = run.runId
        streamRunSse(req, res, run.runId, principal)
        return true
      }
      if (method === 'POST' && sub === 'cancel' && segments.length === 4) {
        const run = await service.cancelRun(principal, id)
        audit.runId = run.runId
        sendJson(res, 200, run)
        return true
      }
      if (method === 'POST' && sub === 'respond' && segments.length === 4) {
        const body = await readJsonBody(req)
        const run = await service.respondRun(principal, id, body)
        audit.runId = run.runId
        sendJson(res, 200, run)
        return true
      }
    }

    // Uploads & Files
    if (resource === 'uploads' && method === 'POST' && segments.length === 2) {
      await handleUpload(req, res, principal)
      return true
    }
    if (resource === 'files' && method === 'GET' && segments.length === 3) {
      await handleFileDownload(res, principal, id)
      return true
    }

    // Events stream & external event ingest
    if (resource === 'events') {
      if (method === 'GET' && id === 'stream' && segments.length === 3) {
        streamGlobalEvents(req, res, principal, url)
        return true
      }
      if (method === 'POST' && segments.length === 2) {
        const body = await readJsonBody(req)
        const idempotencyKey = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : undefined
        const result = await service.ingestEvent(principal, body, { idempotencyKey })
        sendJson(res, result.status === 'duplicate' ? 200 : 202, result)
        return true
      }
    }

    return false
  }

  function dispose() {
    clearInterval(uploadCleaner)
    offFeed?.()
    globalSubscribers.clear()
    for (const entry of uploads.values()) {
      try { rmSync(entry.path, { force: true }) } catch {}
    }
    uploads.clear()
  }

  return { service, handleV1, dispose }
}
