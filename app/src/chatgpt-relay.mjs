import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const OMIT = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id']
const STATES = new Set(['unsupported', 'signed-out', 'signing-in', 'connected', 'plan-usage-off', 'needs-sign-in', 'temporarily-unavailable'])
const invalid = () => Object.assign(new Error('Invalid ChatGPT request.'), { status: 400 })
const TOOL_NAMESPACE = 'ds_bot'
const localTool = item => ['function', 'custom'].includes(item?.type)
const toolCall = item => ['function_call', 'custom_tool_call'].includes(item?.type)

function plainCall(item) {
  if (!toolCall(item) || item.namespace !== TOOL_NAMESPACE) return item
  const next = { ...item }
  delete next.namespace
  return next
}

function plainEvent(frame) {
  const lines = frame.split(/\r\n|\r|\n/)
  const data = lines.filter(line => line === 'data' || line.startsWith('data:'))
  if (!data.length) return frame
  let event
  try { event = JSON.parse(data.map(line => line.slice(5).replace(/^ /, '')).join('\n')) } catch { return frame }
  if (!event || typeof event !== 'object') return frame
  const original = JSON.stringify(event)
  if (event.item) event.item = plainCall(event.item)
  if (event.response && typeof event.response === 'object') {
    const response = { ...event.response }
    if (Array.isArray(response.output)) response.output = response.output.map(plainCall)
    if (Array.isArray(response.tools)) response.tools = response.tools.flatMap(tool => tool?.type === 'namespace' && tool.name === TOOL_NAMESPACE && Array.isArray(tool.tools) ? tool.tools : [tool])
    event.response = response
  }
  const encoded = JSON.stringify(event)
  if (encoded === original) return frame
  let written = false
  const newline = frame.includes('\r\n') ? '\r\n' : frame.includes('\r') ? '\r' : '\n'
  return lines.filter(line => {
    if (line !== 'data' && !line.startsWith('data:')) return true
    if (written) return false
    written = true
    return true
  }).map(line => line === 'data' || line.startsWith('data:') ? `data: ${encoded}` : line).join(newline)
}

async function* plainEvents(source) {
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of source) {
    pending += decoder.decode(chunk, { stream: true })
    let boundary
    while ((boundary = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/.exec(pending))) {
      const end = boundary.index + boundary[0].length
      yield plainEvent(pending.slice(0, end))
      pending = pending.slice(end)
    }
  }
  pending += decoder.decode()
  if (pending) yield plainEvent(pending)
}

export function previewRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid()
  const next = { ...body, store: false, stream: true }
  for (const key of OMIT) delete next[key]
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input
  if (!Array.isArray(input) || (body.instructions !== undefined && typeof body.instructions !== 'string')) throw invalid()
  const instructions = body.instructions ? [body.instructions] : []
  next.input = input.filter(item => {
    if (item?.role !== 'system' || (item.type !== undefined && item.type !== 'message')) return true
    if (typeof item.content === 'string') instructions.push(item.content)
    else if (Array.isArray(item.content) && item.content.every(part => ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string')) {
      instructions.push(item.content.map(part => part.text).join('\n'))
    } else throw invalid()
    return false
  })
  next.input = next.input.map(item => toolCall(item) && item.namespace == null ? { ...item, namespace: TOOL_NAMESPACE } : item)
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw invalid()
    const tools = body.tools.filter(localTool)
    next.tools = body.tools.filter(tool => !localTool(tool))
    if (tools.length) {
      const existing = next.tools.findIndex(tool => tool?.type === 'namespace' && tool.name === TOOL_NAMESPACE)
      if (existing < 0) next.tools.push({ type: 'namespace', name: TOOL_NAMESPACE, description: 'DS Bot tools.', tools })
      else {
        const namespace = next.tools[existing]
        if (!Array.isArray(namespace.tools)) throw invalid()
        next.tools[existing] = { ...namespace, tools: [...namespace.tools, ...tools] }
      }
    }
  }
  if (instructions.length) next.instructions = instructions.join('\n\n')
  return next
}

export async function createChatGPTRelay({ signIn, fetch: fetcher = globalThis.fetch,
  responsesUrl = 'https://api.openai.com/v1/responses', maxBytes = 32 * 1024 * 1024,
}) {
  const secret = randomBytes(32).toString('base64url')
  const authorization = Buffer.from(`Bearer ${secret}`)
  const active = new Set()
  let authority
  const json = (res, status, body) => {
    if (res.destroyed || res.headersSent) return
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const localError = (res, status, code, message = 'ChatGPT is currently unavailable. Check the ChatGPT connection in DS Bot.') => json(res, status, { error: { code, message } })
  const server = createServer((req, res) => {
    const controller = new AbortController()
    active.add(controller)
    res.on('close', () => { if (!res.writableFinished) controller.abort() })
    void (async () => {
      const supplied = Buffer.from(req.headers.authorization ?? '')
      if (req.headers.host !== authority || supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        localError(res, 401, 'relay_unauthorized', 'Unauthorized relay request.')
        return
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        const models = await signIn.listModels()
        json(res, 200, { object: 'list', data: models.map(model => ({ id: model.id, object: 'model', owned_by: 'openai' })) })
        return
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        localError(res, 404, 'relay_not_found', 'Unknown relay endpoint.')
        return
      }
      const chunks = []
      let size = 0
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length
        if (size > maxBytes) {
          req.resume()
          localError(res, 413, 'relay_body_too_large', 'Request body is too large.')
          return
        }
        chunks.push(chunk)
      }
      let body
      try { body = JSON.stringify(previewRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))) } catch { throw invalid() }
      const forward = async () => fetcher(responsesUrl, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await signIn.getAccessToken()}` },
        body, redirect: 'manual', signal: controller.signal,
      })
      let upstream = await forward()
      if (upstream.status === 401) {
        await upstream.body?.cancel()
        await signIn.refresh()
        upstream = await forward()
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel()
        localError(res, 502, 'relay_redirect_refused', 'ChatGPT returned an unexpected redirect.')
        return
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' })
      res.flushHeaders()
      if (upstream.body) {
        const source = Readable.fromWeb(upstream.body)
        if (/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get('content-type') ?? '')) await pipeline(source, plainEvents, res, { signal: controller.signal })
        else await pipeline(source, res, { signal: controller.signal })
      }
      else res.end()
    })().catch(error => {
      if (res.headersSent) { res.destroy(); return }
      if (error.status === 400) { localError(res, 400, 'relay_invalid_request', 'Invalid ChatGPT request.'); return }
      const state = STATES.has(error.state) ? (error.state === 'signed-out' ? 'needs-sign-in' : error.state) : 'temporarily-unavailable'
      localError(res, ['needs-sign-in', 'plan-usage-off', 'signing-in'].includes(state) ? 401 : 503, `chatgpt_${state}`)
    }).finally(() => active.delete(controller))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  authority = `127.0.0.1:${server.address().port}`
  return {
    route: () => ({ baseURL: `http://${authority}/v1`, secret }),
    close: () => { for (const controller of active) controller.abort(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) },
  }
}
