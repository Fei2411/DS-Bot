// External Unified API Gateway (v0.4.0):
//   - Self-hosted node:http server in the lock-holding host process (default OFF, 127.0.0.1:17830)
//   - Writes <home>/api-endpoint.json (0600, no secrets) for local CLI/MCP auto-discovery
//   - Unified Bearer Token auth, scopes, target whitelist, private-Bot isolation, audit log
//   - Serves /v1/* REST + SSE, /mcp Streamable HTTP, and opt-in /compat/openai/v1/*
//   - Read-only hosts never listen; taking over state.lock automatically reconciles and starts it.
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { ALL_SCOPES, createApiAuth, isLoopbackHost } from './auth.js'
import { createMcpHandler } from './mcp.js'
import { createOpenAiHandler } from './openai.js'
import { createApiRoutes, httpError, sendError } from './routes.js'
import { createRunCoordinator } from './runs.js'

const ENDPOINT_FILE = 'api-endpoint.json'

function writeEndpointAtomic(path, data) {
  mkdirSync(join(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(temp, 0o600) } catch { /* windows */ }
  renameSync(temp, path)
}

export function install(rt) {
  const { ctx } = rt
  const endpointPath = join(rt.home, ENDPOINT_FILE)
  const instanceId = randomBytes(6).toString('hex')
  const sseClients = new Set()

  const auth = createApiAuth(rt)
  const runs = createRunCoordinator(rt, auth)
  const routes = createApiRoutes(rt, { auth, runs, sseClients })
  const mcp = createMcpHandler({ service: routes.service })
  const openai = createOpenAiHandler({ auth, service: routes.service, runs, sseClients })

  let server = null
  let boundHost = null
  let boundPort = null
  let lastError = null
  let startedAt = null
  let lifecycle = Promise.resolve()

  function removeOwnEndpointFile() {
    try {
      const current = JSON.parse(readFileSync(endpointPath, 'utf8'))
      if (current?.pid === process.pid && current?.instanceId === instanceId) {
        unlinkSync(endpointPath)
      }
    } catch { /* absent or unreadable */ }
  }

  function writeOwnEndpointFile(host, port) {
    const displayHost = host.includes(':') ? `[${host}]` : host
    const baseUrl = `http://${displayHost}:${port}`
    writeEndpointAtomic(endpointPath, {
      version: 1,
      pid: process.pid,
      instanceId,
      baseUrl,
      mcpUrl: `${baseUrl}/mcp`,
      startedAt,
    })
  }

  async function onRequest(req, res) {
    const started = Date.now()
    const audit = {
      method: req.method,
      path: '',
      tokenId: null,
      tokenName: null,
      status: 0,
    }
    const finishAudit = () => {
      audit.status = res.statusCode || 500
      audit.durationMs = Date.now() - started
      auth.recordAudit(audit)
    }
    res.once('finish', finishAudit)

    try {
      let url
      try {
        url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
      } catch {
        throw httpError(400, 'api/invalid-request-url', 'Malformed request URL or Host header')
      }
      audit.path = url.pathname
      await rt.refresh()
      const check = await auth.authenticate(req)
      if (!check.ok) {
        sendError(res, httpError(check.status, check.code, check.message, check.details))
        return
      }
      const principal = check.token
      audit.tokenId = principal.keyId
      audit.tokenName = principal.name

      const rate = auth.checkRateLimit(principal)
      if (!rate.ok) {
        sendError(res, httpError(rate.status, rate.code, rate.message, rate.details))
        return
      }

      if (await routes.handleV1(req, res, url, principal, audit)) return
      if (await mcp.handleMcp(req, res, url, principal, audit)) return
      if (await openai.handleOpenAi(req, res, url, principal, audit)) return

      sendError(res, httpError(404, 'api/not-found', `Unknown API route: ${req.method} ${url.pathname}`))
    } catch (error) {
      if (!res.headersSent) {
        sendError(res, error)
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  }

  async function stopServer() {
    runs.detachListeners()
    for (const client of Array.from(sseClients)) client.close()
    sseClients.clear()
    const running = server
    server = null
    boundHost = null
    boundPort = null
    startedAt = null
    removeOwnEndpointFile()
    if (running === null) return
    await new Promise((resolve) => {
      try {
        running.closeAllConnections?.()
        running.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  async function startServer(host, port) {
    const nextServer = createServer((req, res) => {
      void onRequest(req, res)
    })
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        nextServer.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        nextServer.removeListener('error', onError)
        resolve()
      }
      nextServer.once('error', onError)
      nextServer.once('listening', onListening)
      nextServer.listen(port, host)
    })
    const addr = nextServer.address()
    const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port
    server = nextServer
    boundHost = host
    boundPort = actualPort
    lastError = null
    startedAt = new Date().toISOString()
    runs.attachListeners()
    writeOwnEndpointFile(host, actualPort)
  }

  function reconcile() {
    lifecycle = lifecycle.then(async () => {
      const cfg = auth.reloadConfig()
      const readOnly = rt.readOnly?.() !== undefined
      if (!cfg.enabled || readOnly) {
        if (server !== null) await stopServer()
        if (!cfg.enabled) lastError = null
        return
      }
      const sameBind = server !== null && boundHost === cfg.host && (cfg.port === 0 || boundPort === cfg.port)
      if (sameBind) return
      if (server !== null) await stopServer()
      try {
        await startServer(cfg.host, cfg.port)
      } catch (error) {
        lastError = error?.code === 'EADDRINUSE'
          ? `Port ${cfg.port} on ${cfg.host} is already in use`
          : (error?.message ?? String(error))
        rt.warn?.('ds-bot: external API server could not bind %s:%s: %s', cfg.host, cfg.port, lastError)
      }
    }).catch(() => {})
    return lifecycle
  }

  function apiView() {
    const cfg = auth.getConfig()
    const readOnly = rt.readOnly?.()
    const running = server !== null && boundPort !== null
    const displayHost = (boundHost ?? cfg.host).includes(':') ? `[${boundHost ?? cfg.host}]` : (boundHost ?? cfg.host)
    const activePort = running ? boundPort : cfg.port
    const baseUrl = running ? `http://${displayHost}:${activePort}` : null
    return {
      enabled: cfg.enabled,
      host: cfg.host,
      port: cfg.port,
      boundPort: running ? boundPort : null,
      openaiCompat: cfg.openaiCompat,
      lanExposed: !isLoopbackHost(cfg.host),
      status: readOnly !== undefined ? 'readonly' : running ? 'running' : cfg.enabled && lastError ? 'error' : 'off',
      ...(readOnly !== undefined ? { readOnly } : {}),
      ...(lastError ? { error: lastError } : {}),
      baseUrl,
      mcpUrl: baseUrl ? `${baseUrl}/mcp` : null,
      openaiUrl: baseUrl && cfg.openaiCompat ? `${baseUrl}/compat/openai/v1` : null,
      endpointPath,
      scopes: ALL_SCOPES,
      tokens: auth.listTokens(),
    }
  }

  async function apiEndpoint(endpoint, body = {}) {
    switch (endpoint) {
      case 'api-set': {
        auth.updateConfig(body)
        await reconcile()
        return apiView()
      }
      case 'api-token-create': {
        const created = auth.createToken(body)
        return { ...created, view: apiView() }
      }
      case 'api-token-update': {
        const meta = auth.updateToken(body.keyId, body)
        return { meta, view: apiView() }
      }
      case 'api-token-revoke': {
        auth.revokeToken(body.keyId)
        return { view: apiView() }
      }
      case 'api-audit': {
        return auth.readAudit({ limit: body.limit, offset: body.offset })
      }
      case 'api-audit-clear': {
        auth.clearAudit()
        return { entries: [], total: 0 }
      }
      default:
        throw Object.assign(new Error(`Unknown API management endpoint: ${endpoint}`), { code: 'bot/not-found' })
    }
  }

  // Reconcile on startup and whenever state.lock ownership changes (read-only takeover).
  rt.onApiStoreSync = () => { void reconcile() }
  rt.apiView = apiView
  rt.apiViaView = () => runs.apiViaView()
  rt.apiEndpoint = apiEndpoint
  rt.apiReconcile = reconcile

  const onProcessExit = () => removeOwnEndpointFile()
  process.once('exit', onProcessExit)

  ctx.effect(() => {
    void rt.load().then(() => reconcile(), () => {})
    return () => {
      process.removeListener('exit', onProcessExit)
      runs.dispose()
      routes.dispose()
      return stopServer()
    }
  }, 'ds-bot: external API gateway')
}
