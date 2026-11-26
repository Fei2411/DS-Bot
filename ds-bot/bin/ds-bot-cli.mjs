#!/usr/bin/env node
// Thin CLI for DS Bot:
//   ds-bot doctor [...]             diagnose / fix stale DSH pins (delegates to ds-bot-doctor.mjs)
//   ds-bot mcp                      stdio <-> Streamable HTTP (/mcp) bridge for external coding agents
//   ds-bot send --bot|--group ...   send a message or background task and optionally wait/stream
//   ds-bot bots | groups            list authorized Bots or group chats
//   ds-bot run <runId> [--cancel]   inspect or cancel a Run
//   ds-bot event ...                submit an external untrusted event to POST /v1/events
//   ds-bot health                   check local API gateway connectivity
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isLoopbackHost } from '../src/host/api/auth.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCTOR_BIN = join(HERE, 'ds-bot-doctor.mjs')

function desktopDataDir() {
  const home = homedir()
  const candidates = process.platform === 'darwin'
    ? [join(home, 'Library', 'Application Support', 'DS Bot', 'locations.json')]
    : process.platform === 'win32'
      ? [join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'DS Bot', 'locations.json')]
      : [join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'DS Bot', 'locations.json')]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed?.dataDir === 'string' && parsed.dataDir.trim() !== '') return parsed.dataDir.trim()
    } catch { /* absent */ }
  }
  return undefined
}

export function discoverEndpoint({ endpoint, home } = {}) {
  const checked = value => {
    let url
    try { url = new URL(value) } catch { throw new Error('Invalid API endpoint URL') }
    const authority = /^http:\/\/([^/\\?#]+)/i.exec(value)?.[1]
    if (url.protocol !== 'http:' || !authority || !isLoopbackHost(authority) || url.username || url.password) {
      throw new Error('API endpoint must use HTTP on a loopback host')
    }
    return value.replace(/\/+$/, '')
  }
  const explicit = endpoint || process.env.DS_BOT_API_ENDPOINT?.trim()
  if (explicit) {
    const baseUrl = checked(explicit)
    return { baseUrl, mcpUrl: `${baseUrl}/mcp` }
  }
  const roots = []
  const explicitHome = home || process.env.DS_BOT_HOME?.trim()
  if (explicitHome) {
    roots.push(explicitHome, join(explicitHome, 'bot'))
  }
  if (process.env.DSH_HOME?.trim()) {
    roots.push(join(process.env.DSH_HOME.trim(), 'bot'))
  }
  const appData = desktopDataDir()
  if (appData) roots.push(join(appData, 'bot'))
  roots.push(join(homedir(), '.ds-bot', 'bot'), join(homedir(), '.dsh', 'bot'))

  for (const dir of roots) {
    const file = join(dir, 'api-endpoint.json')
    if (!existsSync(file)) continue
    let parsed
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
    const baseUrl = checked(parsed?.baseUrl)
    const mcpUrl = parsed.mcpUrl ? checked(parsed.mcpUrl) : `${baseUrl}/mcp`
    return { baseUrl, mcpUrl, file }
  }
  return null
}

export function resolveToken({ tokenFile } = {}) {
  if (tokenFile) {
    try {
      const text = readFileSync(tokenFile, 'utf8').trim()
      if (text !== '') return text
    } catch (error) {
      throw new Error(`Cannot read token file ${tokenFile}: ${error?.message ?? error}`)
    }
  }
  const envToken = process.env.DS_BOT_API_TOKEN?.trim()
  if (envToken) return envToken
  return ''
}

function parseFlags(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq > 2) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true
    } else {
      flags[name] = next
      i += 1
    }
  }
  return { flags, positional }
}

function usage() {
  return [
    'Usage: ds-bot <command> [options]',
    '',
    'Commands:',
    '  mcp                     Bridge stdio MCP to the local DS Bot API (/mcp)',
    '  send                    Send a message or background task to a Bot or group',
    '  bots                    List authorized Bots',
    '  groups                  List authorized group chats',
    '  run <runId>             Inspect or --cancel a Run',
    '  event                   Submit an external event to /v1/events',
    '  health                  Check local API server health',
    '  doctor [--fix]          Diagnose or repair stale DSH package pins',
    '',
    'Global options:',
    '  --endpoint <url>        Override base URL (default: auto-discover api-endpoint.json)',
    '  --home <dir>            Specify DS Bot data directory for endpoint discovery',
    '  --token-file <path>     Read Bearer token from file (default: DS_BOT_API_TOKEN env)',
    '  --json                  Output raw JSON',
  ].join('\n')
}

async function apiRequest({ endpoint, token, method = 'GET', path, body, headers = {} }) {
  const url = `${endpoint.baseUrl}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch {}
  if (!res.ok) {
    const msg = parsed?.error?.message || text || `HTTP ${res.status}`
    const err = new Error(msg)
    err.status = res.status
    err.code = parsed?.error?.code
    throw err
  }
  return parsed
}

function parseSseBlock(block, onEvent) {
  let event = 'message'
  const dataLines = []
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /u, ''))
  }
  const payload = dataLines.join('\n').trim()
  if (payload === '' || payload === '[DONE]') return
  try { onEvent(event, JSON.parse(payload)) } catch {}
}

async function readSse(body, onEvent) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let match
    while ((match = /\r?\n\r?\n/u.exec(buffer)) !== null) {
      parseSseBlock(buffer.slice(0, match.index), onEvent)
      buffer = buffer.slice(match.index + match[0].length)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim() !== '') parseSseBlock(buffer, onEvent)
}

async function runMcpBridge({ endpoint, token }) {
  const url = endpoint.mcpUrl
  const inFlight = new Set()
  const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
  const sendError = (id, code, message) => {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  async function forward(raw) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const hasId = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.id !== undefined
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: raw,
      })
    } catch (error) {
      sendError(hasId ? parsed.id : undefined, -32603, error instanceof Error ? error.message : String(error))
      return
    }
    if (response.status === 202 || response.status === 204) {
      await response.body?.cancel().catch(() => {})
      return
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim()
      sendError(hasId ? parsed.id : undefined, -32603, detail || `MCP HTTP ${response.status}`)
      return
    }
    const ct = response.headers.get('content-type') ?? ''
    if (ct.includes('text/event-stream') && response.body !== null) {
      await readSse(response.body, (_event, msg) => send(msg))
      return
    }
    const text = (await response.text()).trim()
    if (text === '') return
    try {
      const data = JSON.parse(text)
      if (Array.isArray(data)) for (const item of data) send(item)
      else send(data)
    } catch {
      if (hasId) sendError(parsed.id, -32603, 'Invalid MCP JSON response')
    }
  }

  return await new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
    lines.on('line', (line) => {
      const trimmed = line.trim()
      if (trimmed === '') return
      const task = forward(trimmed).finally(() => inFlight.delete(task))
      inFlight.add(task)
    })
    lines.on('close', () => {
      void Promise.allSettled(inFlight).then(() => resolve(0))
    })
  })
}

export async function main(argv) {
  const [command, ...rest] = argv.slice(2)
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(usage())
    return command ? 0 : 2
  }
  if (command === 'doctor') {
    const result = spawnSync(process.execPath, [DOCTOR_BIN, 'doctor', ...rest], { stdio: 'inherit' })
    return result.status ?? 1
  }

  const { flags, positional } = parseFlags(rest)
  const endpoint = discoverEndpoint({
    endpoint: typeof flags.endpoint === 'string' ? flags.endpoint : undefined,
    home: typeof flags.home === 'string' ? flags.home : undefined,
  })
  if (endpoint === null) {
    console.error('ds-bot: local API endpoint not found. Enable Settings → API in DS Bot, or pass --endpoint <url>.')
    return 1
  }
  let token
  try {
    token = resolveToken({ tokenFile: typeof flags['token-file'] === 'string' ? flags['token-file'] : undefined })
  } catch (error) {
    console.error(`ds-bot: ${error.message}`)
    return 1
  }
  if (!token) {
    console.error('ds-bot: missing API token. Set DS_BOT_API_TOKEN or pass --token-file <path>.')
    return 1
  }

  const asJson = flags.json === true

  try {
    if (command === 'mcp') {
      return await runMcpBridge({ endpoint, token })
    }
    if (command === 'health') {
      const data = await apiRequest({ endpoint, token, path: '/v1/health' })
      console.log(asJson ? JSON.stringify(data, null, 2) : `ok · v${data.pluginVersion} · ${endpoint.baseUrl}`)
      return 0
    }
    if (command === 'bots') {
      const data = await apiRequest({ endpoint, token, path: '/v1/bots' })
      if (asJson) console.log(JSON.stringify(data, null, 2))
      else for (const b of data.bots ?? []) console.log(`${b.id}\t${b.name}\t${b.role || '-'}\t${b.busy ? 'busy' : 'idle'}`)
      return 0
    }
    if (command === 'groups') {
      const data = await apiRequest({ endpoint, token, path: '/v1/groups' })
      if (asJson) console.log(JSON.stringify(data, null, 2))
      else for (const g of data.groups ?? []) console.log(`${g.id}\t${g.name}\t${(g.members ?? []).length} members\t${g.busy ? 'busy' : 'idle'}`)
      return 0
    }
    if (command === 'run') {
      const runId = positional[0]
      if (!runId) {
        console.error('ds-bot run: missing <runId>')
        return 2
      }
      const data = flags.cancel === true
        ? await apiRequest({ endpoint, token, method: 'POST', path: `/v1/runs/${encodeURIComponent(runId)}/cancel` })
        : await apiRequest({ endpoint, token, path: `/v1/runs/${encodeURIComponent(runId)}` })
      if (asJson) console.log(JSON.stringify(data, null, 2))
      else {
        console.log(`${data.runId} · ${data.status}`)
        if (data.output?.text) console.log(data.output.text)
        if (data.pendingAction) console.log(`waiting_human (${data.pendingAction.kind}): ${data.pendingAction.summary}`)
      }
      return 0
    }
    if (command === 'send') {
      const bot = typeof flags.bot === 'string' ? flags.bot : undefined
      const group = typeof flags.group === 'string' ? flags.group : undefined
      const text = typeof flags.text === 'string' ? flags.text : ''
      if ((!bot && !group) || (bot && group) || text.trim() === '') {
        console.error('ds-bot send: specify --bot <id|name> or --group <id|name>, and --text "..."')
        return 2
      }
      const path = bot
        ? `/v1/bots/${encodeURIComponent(bot)}/messages`
        : `/v1/groups/${encodeURIComponent(group)}/messages`
      const headers = {}
      if (typeof flags['idempotency-key'] === 'string') headers['Idempotency-Key'] = flags['idempotency-key']
      const body = {
        text,
        ...(bot && flags.task === true ? { mode: 'task' } : {}),
        ...(typeof flags.title === 'string' ? { title: flags.title } : {}),
        ...(group && typeof flags.mentions === 'string' ? { mentions: flags.mentions.split(',').map(s => s.trim()).filter(Boolean) } : {}),
        ...(flags.wait !== undefined ? { wait: Number(flags.wait) || 0 } : {}),
        ...(flags.stream === true ? { stream: true } : {}),
      }
      if (flags.stream === true) {
        const res = await fetch(`${endpoint.baseUrl}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          console.error(`ds-bot send: HTTP ${res.status} ${await res.text()}`)
          return 1
        }
        await readSse(res.body, (event, payload) => {
          if (asJson) console.log(JSON.stringify({ event, ...payload }))
          else if (event === 'delta' && payload.text) process.stdout.write(payload.text)
          else if (event === 'group.message' && payload.message) console.log(`${payload.message.name}: ${payload.message.text}`)
          else if (event === 'human.required') console.error(`\n[waiting_human: ${payload.pendingAction?.summary ?? ''}]`)
          else if (event === 'run.completed') console.log('')
        })
        return 0
      }
      const data = await apiRequest({ endpoint, token, method: 'POST', path, body, headers })
      if (asJson) console.log(JSON.stringify(data, null, 2))
      else {
        console.log(`${data.runId} · ${data.status}`)
        if (data.output?.text) console.log(data.output.text)
        if (data.pendingAction) console.log(`waiting_human (${data.pendingAction.kind}): ${data.pendingAction.summary}`)
      }
      return 0
    }
    if (command === 'event') {
      const source = typeof flags.source === 'string' ? flags.source : 'cli'
      const type = typeof flags.type === 'string' ? flags.type : 'external.event'
      let payload
      if (typeof flags.payload === 'string') {
        try { payload = JSON.parse(flags.payload) } catch { payload = flags.payload }
      }
      const body = {
        source,
        type,
        ...(typeof flags['event-id'] === 'string' ? { eventId: flags['event-id'] } : {}),
        ...(typeof flags['thread-key'] === 'string' ? { threadKey: flags['thread-key'] } : {}),
        ...(typeof flags.title === 'string' ? { title: flags.title } : {}),
        ...(typeof flags.summary === 'string' ? { summary: flags.summary } : {}),
        ...(payload !== undefined ? { payload } : {}),
        ...(typeof flags.bot === 'string' ? { target: { kind: 'bot', id: flags.bot } } : {}),
        ...(typeof flags.group === 'string' ? { target: { kind: 'group', id: flags.group } } : {}),
        dryRun: flags['dry-run'] === true,
      }
      const data = await apiRequest({ endpoint, token, method: 'POST', path: '/v1/events', body })
      console.log(asJson ? JSON.stringify(data, null, 2) : `${data.ledgerEventId} · ${data.status}`)
      return 0
    }
    console.error(`ds-bot: unknown command "${command}"\n\n${usage()}`)
    return 2
  } catch (error) {
    console.error(`ds-bot ${command}: ${error?.message ?? error}`)
    return 1
  }
}

function invokedDirectly() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  }
}

if (invokedDirectly()) {
  main(process.argv).then(code => process.exit(code))
}
