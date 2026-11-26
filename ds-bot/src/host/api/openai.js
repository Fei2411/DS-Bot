// Thin opt-in OpenAI-compatible adapter (/compat/openai/v1/*) backed by the exact same
// Run coordinator, auth, scopes, and privacy filters as /v1/*.
import { httpError, readJsonBody, sendJson } from './routes.js'

const BOT_PREFIX = 'dsbot/bot/'
const GROUP_PREFIX = 'dsbot/group/'
const DEFAULT_SYNC_WAIT_SEC = 180

function extractLastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg?.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content.trim()
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n')
        .trim()
    }
  }
  return ''
}

function parseModelTarget(model) {
  const raw = String(model ?? '').trim()
  if (raw.startsWith(BOT_PREFIX)) return { kind: 'bot', id: raw.slice(BOT_PREFIX.length) }
  if (raw.startsWith(GROUP_PREFIX)) return { kind: 'group', id: raw.slice(GROUP_PREFIX.length) }
  return null
}

function waitingNotice(run) {
  const action = run.pendingAction
  if (!action) return '[DS Bot paused: waiting for human input]'
  return `[DS Bot paused (waiting_human · ${action.kind}): ${action.summary}. Run ID: ${run.runId}]`
}

export function createOpenAiHandler({ auth, service, runs, sseClients }) {
  async function handleOpenAi(req, res, url, principal, audit) {
    if (!url.pathname.startsWith('/compat/openai/v1/')) return false
    if (auth.getConfig().openaiCompat !== true) {
      throw httpError(404, 'api/compat-disabled', 'OpenAI compatibility layer is disabled in Settings → API')
    }

    const sub = url.pathname.slice('/compat/openai/v1/'.length)
    if (req.method === 'GET' && sub === 'models') {
      const { bots } = service.listBots(principal)
      const { groups } = service.listGroups(principal)
      const now = Math.floor(Date.now() / 1000)
      const data = [
        ...bots.map(bot => ({
          id: `${BOT_PREFIX}${bot.id}`,
          object: 'model',
          created: now,
          owned_by: 'ds-bot',
          metadata: { kind: 'bot', name: bot.name, role: bot.role },
        })),
        ...groups.map(group => ({
          id: `${GROUP_PREFIX}${group.id}`,
          object: 'model',
          created: now,
          owned_by: 'ds-bot',
          metadata: { kind: 'group', name: group.name },
        })),
      ]
      sendJson(res, 200, { object: 'list', data })
      return true
    }

    if (req.method === 'POST' && sub === 'chat/completions') {
      const body = await readJsonBody(req)
      const target = parseModelTarget(body.model)
      if (target === null) {
        throw httpError(400, 'api/invalid-model', 'model must be "dsbot/bot/<id>" or "dsbot/group/<id>"')
      }
      const text = extractLastUserText(body.messages)
      if (text === '') {
        throw httpError(400, 'api/invalid', 'messages must contain at least one non-empty user message')
      }
      const idempotencyKey = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : undefined
      const wantsStream = body.stream === true
      const created = Math.floor(Date.now() / 1000)
      const wait = wantsStream ? 0 : DEFAULT_SYNC_WAIT_SEC

      const { run } = target.kind === 'bot'
        ? await service.sendToBot(principal, target.id, { text, mode: 'chat', wait }, { idempotencyKey })
        : await service.sendToGroup(principal, target.id, { text, wait }, { idempotencyKey })

      audit.targetKind = run.target.kind
      audit.targetId = run.target.id
      audit.targetName = run.target.name
      audit.runId = run.runId

      const modelId = `${target.kind === 'bot' ? BOT_PREFIX : GROUP_PREFIX}${run.target.id}`
      const chatId = `chatcmpl-${run.runId}`

      if (wantsStream) {
        let unsub
        let authTimer
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-dsbot-run-id': run.runId,
          'x-dsbot-status': run.status,
        })
        const sendChunk = (delta, finishReason = null) => {
          if (principal.isCurrent?.() === false) { client.close(); return }
          if (res.writableEnded) return
          res.write(`data: ${JSON.stringify({
            id: chatId,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`)
        }
        const client = {
          res,
          close: () => {
            clearInterval(authTimer)
            unsub?.()
            sseClients.delete(client)
            if (!res.writableEnded) {
              try { res.write('data: [DONE]\n\n'); res.end() } catch {}
            }
          },
        }
        sseClients.add(client)
        authTimer = setInterval(() => {
          if (principal.isCurrent?.() === false) client.close()
        }, 1_000)
        authTimer.unref?.()
        sendChunk({ role: 'assistant' })
        let sawDelta = false
        unsub = runs.subscribeRun(run.runId, (entry) => {
          if (entry.event === 'delta' && typeof entry.data?.text === 'string') {
            sawDelta = true
            sendChunk({ content: entry.data.text })
          } else if (entry.event === 'group.message' && entry.data?.message) {
            sawDelta = true
            sendChunk({ content: `${entry.data.message.name}: ${entry.data.message.text}\n\n` })
          } else if (entry.event === 'human.required') {
            const latest = runs.getRunForPrincipal(run.runId, principal)
            sendChunk({ content: `\n${waitingNotice(latest.ok ? latest.run : run)}` }, 'stop')
            if (!res.writableEnded) {
              res.write('data: [DONE]\n\n')
              res.end()
            }
            sseClients.delete(client)
            clearInterval(authTimer)
            unsub?.()
          } else if (entry.event === 'run.completed' || entry.event === 'run.failed' || entry.event === 'run.stopped') {
            if (!sawDelta && entry.data?.output?.text) {
              sendChunk({ content: entry.data.output.text })
            }
            sendChunk({}, 'stop')
            if (!res.writableEnded) {
              res.write('data: [DONE]\n\n')
              res.end()
            }
            sseClients.delete(client)
            clearInterval(authTimer)
            unsub?.()
          }
        })
        if (res.writableEnded) { clearInterval(authTimer); unsub?.() }
        req.on('close', () => {
          clearInterval(authTimer)
          sseClients.delete(client)
          unsub?.()
        })
        return true
      }

      if (run.status === 'failed') {
        throw httpError(502, run.error?.code ?? 'bot/turn-failed', run.error?.message ?? 'Bot run failed')
      }
      const content = run.status === 'waiting_human'
        ? `${run.output.text ? `${run.output.text}\n\n` : ''}${waitingNotice(run)}`
        : (run.output.text || '')

      sendJson(res, 200, {
        id: chatId,
        object: 'chat.completion',
        created,
        model: modelId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: run.usage.inputTokens,
          completion_tokens: run.usage.outputTokens,
          total_tokens: run.usage.inputTokens + run.usage.outputTokens,
        },
      }, {
        'x-dsbot-run-id': run.runId,
        'x-dsbot-status': run.status,
      })
      return true
    }

    return false
  }

  return { handleOpenAi }
}
