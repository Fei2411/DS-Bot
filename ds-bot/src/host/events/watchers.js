// Mechanical Watchers: zero-token polling and folder watchers run only by the host that
// holds state.lock. Supports github (ETag 304), mail, folder, https/rss, and user-only
// local command probes. Built-in guardrails: first-run baseline, self-trigger filtering,
// DNS/redirect/IPv6 SSRF defense + bounded body reads, private-Bot folder fencing,
// atomic commit-after-intake checkpoints, and consecutive-error/401 auto-pause.
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lookup as dnsLookup } from 'node:dns/promises'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, watch as fsWatch, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'

const WATCHER_KINDS = new Set(['github', 'mail', 'folder', 'http', 'command'])
const MIN_INTERVAL_SEC = 15
const DEFAULT_INTERVALS = { github: 60, mail: 60, folder: 30, http: 300, command: 60 }
const MAX_CONSECUTIVE_ERRORS = 5
const FETCH_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5
const MAX_HTTP_BODY_BYTES = 1024 * 1024
const COMMAND_TIMEOUT_MS = 15_000
const COMMAND_MAX_BUFFER = 64 * 1024
const FOLDER_DEBOUNCE_MS = 1500
const IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])

const newWatcherId = () => `w_${randomBytes(4).toString('hex')}`
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const sha256 = text => createHash('sha256').update(String(text ?? '')).digest('hex')

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic(path, data) {
  mkdirSync(join(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true // multicast / reserved
  return false
}

function expandIpv6Hextets(ip) {
  let text = ip
  // Convert trailing dotted-quad IPv4 suffix (e.g. ::ffff:127.0.0.1 or ::127.0.0.1) to two hextets.
  const lastColon = text.lastIndexOf(':')
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const v4 = text.slice(lastColon + 1)
    if (isIP(v4) !== 4) return null
    const octets = v4.split('.').map(Number)
    const hi = ((octets[0] << 8) | octets[1]).toString(16)
    const lo = ((octets[2] << 8) | octets[3]).toString(16)
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - (left.length + right.length)
  if (halves.length === 1 && missing !== 0) return null
  if (missing < 0) return null
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (groups.length !== 8) return null
  const nums = groups.map(g => Number.parseInt(g, 16))
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null
  return nums
}

export function isPrivateIp(rawIp) {
  const ip = String(rawIp ?? '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  const kind = isIP(ip)
  if (kind === 4) return isPrivateIpv4(ip)
  if (kind === 6) {
    const h = expandIpv6Hextets(ip)
    if (!h) return true
    const allZeroPrefix = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0
    // Unspecified (::) and loopback (::1, 0:0:0:0:0:0:0:1)
    if (allZeroPrefix && h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true
    // IPv4-mapped (::ffff:0:0/96) or deprecated IPv4-compatible (::a.b.c.d)
    if (allZeroPrefix && (h[5] === 0xffff || h[5] === 0)) {
      const v4 = `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`
      return isPrivateIpv4(v4)
    }
    // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
    if (h[0] === 0x0064 && h[1] === 0xff9b) {
      if (h[2] === 0x0001) return true
      if (h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
        const v4 = `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`
        return isPrivateIpv4(v4)
      }
    }
    if ((h[0] & 0xfe00) === 0xfc00) return true // ULA fc00::/7
    if ((h[0] & 0xffc0) === 0xfe80) return true // link-local fe80::/10
    if ((h[0] & 0xff00) === 0xff00) return true // multicast ff00::/8
    return false
  }
  return true
}

export function checkHttpUrlSyntax(raw) {
  let parsed
  try { parsed = new URL(String(raw ?? '')) } catch { return 'Enter a valid https:// URL' }
  if (parsed.protocol !== 'https:') return 'HTTP watchers only allow https:// URLs'
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return 'HTTP watchers cannot target loopback or private network addresses'
  }
  if (isIP(host) !== 0 && isPrivateIp(host)) {
    return 'HTTP watchers cannot target loopback or private network addresses'
  }
  return null
}

async function assertSafePublicUrl(raw, { lookup = dnsLookup, skipDns = false } = {}) {
  const syntaxErr = checkHttpUrlSyntax(raw)
  if (syntaxErr) throw invalid(syntaxErr)
  if (skipDns) return new URL(raw)
  const parsed = new URL(raw)
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0) {
    if (isPrivateIp(host)) throw invalid('HTTP watchers cannot target loopback or private network addresses')
    return parsed
  }
  let records
  try {
    records = await lookup(host, { all: true })
  } catch {
    throw new Error(`Could not resolve host ${host}`)
  }
  if (!Array.isArray(records) || records.length === 0) throw new Error(`Could not resolve host ${host}`)
  for (const rec of records) {
    if (isPrivateIp(rec.address)) {
      throw invalid('HTTP watchers cannot target loopback or private network addresses')
    }
  }
  return parsed
}

async function readBoundedText(res, maxBytes = MAX_HTTP_BODY_BYTES) {
  const lenHeader = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(lenHeader) && lenHeader > maxBytes) {
    await res.body?.cancel?.().catch(() => {})
    throw new Error(`HTTP response exceeds ${maxBytes} bytes limit`)
  }
  if (!res.body?.getReader) {
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`HTTP response exceeds ${maxBytes} bytes limit`)
    return text
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`HTTP response exceeds ${maxBytes} bytes limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8')
}

// Lightweight RSS / Atom item extractor without third-party XML dependencies.
function parseFeedItems(xml) {
  const items = []
  const blocks = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? []
  const pick = (block, tag) => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)
    if (!m) return ''
    return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim()
  }
  const linkOf = (block) => {
    const attr = /<link\b[^>]*href=["']([^"']+)["']/i.exec(block)
    return attr ? attr[1] : pick(block, 'link')
  }
  for (const block of blocks.slice(0, 30)) {
    const title = pick(block, 'title')
    const link = linkOf(block)
    const id = pick(block, 'guid') || pick(block, 'id') || link || sha256(title).slice(0, 16)
    const summary = pick(block, 'description') || pick(block, 'summary')
    if (title || link) items.push({ id, title: title || link, link, summary })
  }
  return items
}

function scanFolderSnapshot(dir) {
  const snapshot = {}
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return snapshot }
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name) || entry.name.endsWith('.tmp')) continue
    if (!entry.isFile()) continue
    const full = join(dir, entry.name)
    try {
      const st = statSync(full)
      if (st.size <= 256 * 1024) {
        snapshot[entry.name] = sha256(readFileSync(full))
      } else {
        snapshot[entry.name] = `${st.size}:${Math.floor(st.mtimeMs)}`
      }
    } catch { /* file vanished mid-scan */ }
  }
  return snapshot
}

export function createWatchers(rt, { onEvent, onAlert, onResume } = {}) {
  const dir = join(rt.home, 'events')
  const sourcesPath = join(dir, 'sources.json')
  const runtimeDir = join(dir, 'runtime')

  let sources = readJson(sourcesPath, [])
  if (!Array.isArray(sources)) sources = []

  const timers = new Map()
  const fsWatchers = new Map()
  const folderDebounce = new Map()
  const inFlight = new Set()
  const writes = () => rt.readOnly?.() === undefined

  const saveSources = () => { if (writes()) writeJsonAtomic(sourcesPath, sources) }
  const runtimePath = id => join(runtimeDir, `${id}.json`)
  const readRuntime = id => readJson(runtimePath(id), {
    baselined: false,
    cursor: null,
    etag: null,
    lastModified: null,
    lastHash: null,
    changeSeq: 0,
    seenIds: [],
    snapshot: null,
    selfActor: null,
    errorCount: 0,
    lastError: null,
    lastCheckedAt: null,
    pausedReason: null,
  })
  const saveRuntime = (id, data) => { if (writes()) writeJsonAtomic(runtimePath(id), data) }

  const reloadIfReadOnly = () => {
    if (!writes()) {
      const loaded = readJson(sourcesPath, [])
      if (Array.isArray(loaded)) sources = loaded
    }
  }

  const isWatcherPrivate = watcher => watcher?.target?.kind === 'bot' && rt.botOf(watcher.target.botId)?.private === true

  function listWatchers({ callerBotId, isUser = false } = {}) {
    reloadIfReadOnly()
    return sources
      .filter((w) => {
        if (isUser) return true
        if (isWatcherPrivate(w) && w.target?.botId !== callerBotId) return false
        return true
      })
      .map(w => ({ ...w, runtime: readRuntime(w.id) }))
  }

  function validateTarget(target) {
    if (!target || typeof target !== 'object') throw invalid('Pick a Bot or group chat for this watcher')
    if (target.kind === 'bot') {
      if (!rt.botOf(target.botId)) throw invalid(`Unknown Bot ${target.botId}`)
      return { kind: 'bot', botId: target.botId }
    }
    if (target.kind === 'room') {
      if (!rt.roomOf(target.roomId)) throw invalid(`Unknown group chat ${target.roomId}`)
      return { kind: 'room', roomId: target.roomId }
    }
    throw invalid(`Unsupported watcher target: ${target.kind}`)
  }

  async function validateKindConfig(kind, config, { isUser, callerBotId }) {
    const cfg = config && typeof config === 'object' ? { ...config } : {}
    if (kind === 'command' && !isUser) {
      throw invalid('Only the user can create or change local command watchers')
    }
    if (kind === 'github') {
      const repo = String(cfg.repo ?? '').trim()
      const [owner, name] = repo.split('/')
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || owner === '.' || owner === '..' || name === '.' || name === '..') {
        throw invalid('GitHub watcher needs repo in owner/name format')
      }
      return {
        repo,
        events: Array.isArray(cfg.events) && cfg.events.length > 0 ? cfg.events.map(String) : ['PullRequestEvent', 'PullRequestReviewEvent', 'IssueCommentEvent', 'IssuesEvent'],
        authorAssociations: Array.isArray(cfg.authorAssociations) ? cfg.authorAssociations.map(String) : [],
      }
    }
    if (kind === 'mail') {
      return {
        account: String(cfg.account ?? '').trim(),
        folder: String(cfg.folder ?? 'INBOX').trim() || 'INBOX',
        fromFilter: String(cfg.fromFilter ?? '').trim(),
      }
    }
    if (kind === 'folder') {
      const path = String(cfg.path ?? '').trim()
      if (path === '') throw invalid('Folder watcher needs a folder path')
      const resolvedPath = resolve(path)
      if (!isUser && rt.pathClosedForBot) {
        const closed = await rt.pathClosedForBot(resolvedPath, callerBotId, { search: true })
        if (closed) throw invalid(`Cannot watch ${resolvedPath}: it overlaps private or protected data (${closed.name})`)
      }
      return { path: resolvedPath }
    }
    if (kind === 'http') {
      const url = String(cfg.url ?? '').trim()
      if (!rt.config.events?.allowInsecureHttp) {
        try {
          await assertSafePublicUrl(url, { lookup: lookupImpl() })
        } catch (error) {
          // Reject all invalid syntax and private/loopback DNS targets immediately at save time;
          // allow saving a syntactically valid public hostname if offline DNS fails (it will still
          // be re-validated on every fetch hop before any network call).
          if (error?.code === 'bot/invalid') throw error
        }
      }
      return { url, format: cfg.format === 'rss' ? 'rss' : cfg.format === 'json' ? 'json' : 'auto' }
    }
    if (kind === 'command') {
      const executable = String(cfg.executable ?? '').trim()
      if (executable === '') throw invalid('Command watcher needs an executable')
      const args = Array.isArray(cfg.args) ? cfg.args.map(String) : []
      let fallbackCwd = process.cwd()
      try { fallbackCwd = rt.teamFolder?.() ?? fallbackCwd } catch { /* workspaces service unavailable */ }
      const cwd = cfg.cwd ? resolve(String(cfg.cwd)) : fallbackCwd
      return { executable, args, cwd }
    }
    throw invalid(`Unsupported watcher kind: ${kind}`)
  }

  async function saveWatcher(input, { isUser = false, callerBotId } = {}) {
    if (!writes()) throw invalid('Team is read-only in this window')
    const kind = String(input.kind ?? '').trim()
    if (!WATCHER_KINDS.has(kind)) throw invalid(`Unsupported watcher kind: ${kind}`)
    const existingIdx = input.id ? sources.findIndex(w => w.id === input.id) : -1
    const existing = existingIdx >= 0 ? sources[existingIdx] : null
    if (existing && existing.kind === 'command' && !isUser) {
      throw invalid('Only the user can change local command watchers')
    }
    const target = validateTarget(input.target ?? existing?.target)
    if (!isUser && target.kind === 'bot' && rt.botOf(target.botId)?.private === true) {
      throw invalid('Only the user can manage watchers for a private Bot')
    }
    const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 100)
    if (name === '') throw invalid('Give the watcher a name')
    const config = await validateKindConfig(kind, input.config ?? existing?.config, { isUser, callerBotId })
    const rawInterval = Number(input.intervalSec ?? existing?.intervalSec ?? DEFAULT_INTERVALS[kind])
    const intervalSec = Math.max(MIN_INTERVAL_SEC, Math.min(86400, Number.isFinite(rawInterval) ? Math.round(rawInterval) : DEFAULT_INTERVALS[kind]))
    const now = Date.now()
    const record = {
      id: existing?.id ?? newWatcherId(),
      name,
      kind,
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : (existing?.enabled ?? true),
      intervalSec,
      target,
      config,
      speculative: isUser ? Boolean(input.speculative ?? existing?.speculative ?? false) : Boolean(existing?.speculative ?? false),
      createdBy: existing?.createdBy ?? (isUser ? 'user' : callerBotId ?? 'system'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (existingIdx >= 0) sources[existingIdx] = record
    else sources.push(record)
    saveSources()
    if (existing && !existing.enabled && record.enabled) onResume?.(record.id)
    reschedule(record)
    return { ...record, runtime: readRuntime(record.id) }
  }

  function toggleWatcher(id, enabled, { isUser = false } = {}) {
    if (!writes()) throw invalid('Team is read-only in this window')
    const watcher = sources.find(w => w.id === id)
    if (!watcher) throw invalid('Unknown watcher')
    if (!isUser && (watcher.kind === 'command' || isWatcherPrivate(watcher))) {
      throw invalid('Only the user can change this watcher')
    }
    watcher.enabled = Boolean(enabled)
    watcher.updatedAt = Date.now()
    saveSources()
    if (watcher.enabled) {
      const rtState = readRuntime(id)
      rtState.errorCount = 0
      rtState.lastError = null
      rtState.pausedReason = null
      saveRuntime(id, rtState)
      onResume?.(watcher.id)
    }
    reschedule(watcher)
    return { ...watcher, runtime: readRuntime(id) }
  }

  function deleteWatcher(id, { isUser = false } = {}) {
    if (!writes()) throw invalid('Team is read-only in this window')
    const idx = sources.findIndex(w => w.id === id)
    if (idx === -1) throw invalid('Unknown watcher')
    const watcher = sources[idx]
    if (!isUser && (watcher.kind === 'command' || isWatcherPrivate(watcher))) {
      throw invalid('Only the user can delete this watcher')
    }
    unschedule(id)
    sources.splice(idx, 1)
    saveSources()
    try { unlinkSync(runtimePath(id)) } catch {}
    return true
  }

  // --- Probe implementations (mutate only a cloned candidate state) ------

  const fetchImpl = () => rt.config.events?.fetch ?? globalThis.fetch
  const lookupImpl = () => rt.config.events?.lookup ?? dnsLookup

  async function probeGithub(watcher, rtState) {
    await rt.loadSecrets?.()
    if (rt.secretStoreStatus?.().locked === true) return { events: [], skippedLocked: true }
    const token = rt.secretValue?.('GITHUB_TOKEN') ?? rt.config.events?.githubToken
    if (!token) throw Object.assign(new Error('GitHub is not signed in'), { authFailed: true })
    const apiBase = (rt.config.github?.api ?? 'https://api.github.com').replace(/\/$/, '')
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ds-bot',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (rtState.etag) headers['If-None-Match'] = rtState.etag

    if (!rtState.selfActor && rt.config.events?.githubSelfLogin !== undefined) {
      rtState.selfActor = rt.config.events.githubSelfLogin
    } else if (!rtState.selfActor) {
      const me = await fetchImpl()(`${apiBase}/user`, { headers: { ...headers, 'If-None-Match': '' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null)
      if (me?.ok) {
        const data = await me.json().catch(() => null)
        if (typeof data?.login === 'string') rtState.selfActor = data.login.toLowerCase()
      }
    }

    const res = await fetchImpl()(`${apiBase}/repos/${watcher.config.repo}/events?per_page=30`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.status === 304) return { events: [], changed: false }
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`GitHub authentication failed (${res.status}) — sign in again`), { authFailed: true })
    }
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`)

    const etag = res.headers.get('etag')
    if (etag) rtState.etag = etag
    const raw = await res.json().catch(() => [])
    if (!Array.isArray(raw)) return { events: [], changed: false }

    const allowedTypes = new Set(watcher.config.events ?? [])
    const allowedAssoc = new Set((watcher.config.authorAssociations ?? []).map(s => s.toUpperCase()))
    const seen = new Set(rtState.seenIds ?? [])
    const emitted = []

    for (const item of [...raw].reverse()) {
      const id = String(item?.id ?? '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      if (!rtState.baselined) continue
      if (allowedTypes.size > 0 && !allowedTypes.has(item.type)) continue
      const actor = String(item.actor?.login ?? '').toLowerCase()
      if (rtState.selfActor && actor === rtState.selfActor) continue
      const assoc = String(item.payload?.comment?.author_association ?? item.payload?.review?.author_association ?? item.payload?.pull_request?.author_association ?? item.payload?.issue?.author_association ?? '').toUpperCase()
      if (allowedAssoc.size > 0 && assoc && !allowedAssoc.has(assoc)) continue

      const num = item.payload?.pull_request?.number ?? item.payload?.issue?.number
      const title = item.payload?.pull_request?.title ?? item.payload?.issue?.title ?? item.type
      const body = item.payload?.comment?.body ?? item.payload?.review?.body ?? item.payload?.pull_request?.body ?? item.payload?.issue?.body ?? ''
      const url = item.payload?.comment?.html_url ?? item.payload?.review?.html_url ?? item.payload?.pull_request?.html_url ?? item.payload?.issue?.html_url ?? `https://github.com/${watcher.config.repo}`
      const threadKey = num !== undefined ? `github:${watcher.config.repo}#${num}` : `github:${watcher.config.repo}`
      emitted.push({
        source: { kind: 'github', id: watcher.id, name: watcher.name, actor: item.actor?.login ?? '', actorTrusted: false },
        trust: 'external',
        threadKey,
        entityKey: threadKey,
        eventType: `github.${item.type}`,
        // Scoped by watcher.id so two watchers on the same repo never suppress each other.
        dedupeKey: `github:${watcher.id}:${watcher.config.repo}:${id}`,
        summary: `${item.actor?.login ?? 'someone'} · ${item.type}${num !== undefined ? ` #${num}` : ''}: ${title}`,
        body,
        meta: { repo: watcher.config.repo, number: num, url },
      })
    }

    rtState.seenIds = [...seen].slice(-200)
    rtState.baselined = true
    return { events: emitted, changed: emitted.length > 0 }
  }

  async function fetchSafeHttp(initialUrl, headers) {
    const skipDns = rt.config.events?.allowInsecureHttp === true || (rt.config.events?.fetch !== undefined && rt.config.events?.lookup === undefined)
    let current = initialUrl
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!rt.config.events?.allowInsecureHttp) {
        await assertSafePublicUrl(current, { lookup: lookupImpl(), skipDns })
      }
      const res = await fetchImpl()(current, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.headers?.get?.('location')
        await res.body?.cancel?.().catch(() => {})
        if (!location) throw new Error(`HTTP redirect (${res.status}) missing Location header`)
        if (hop === MAX_REDIRECTS) throw new Error('HTTP watcher exceeded redirect limit')
        current = new URL(location, current).toString()
        continue
      }
      return res
    }
    throw new Error('HTTP watcher exceeded redirect limit')
  }

  async function probeHttp(watcher, rtState) {
    const headers = { 'User-Agent': 'ds-bot' }
    if (rtState.etag) headers['If-None-Match'] = rtState.etag
    if (rtState.lastModified) headers['If-Modified-Since'] = rtState.lastModified
    const res = await fetchSafeHttp(watcher.config.url, headers)
    if (res.status === 304) return { events: [], changed: false }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel?.().catch(() => {})
      throw Object.assign(new Error(`HTTP source refused access (${res.status})`), { authFailed: true })
    }
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {})
      throw new Error(`HTTP source returned ${res.status}`)
    }

    const etag = res.headers.get('etag')
    const lastMod = res.headers.get('last-modified')
    if (etag) rtState.etag = etag
    if (lastMod) rtState.lastModified = lastMod

    const text = await readBoundedText(res, rt.config.events?.maxHttpBodyBytes ?? MAX_HTTP_BODY_BYTES)
    const hash = sha256(text)
    if (rtState.lastHash === hash) return { events: [], changed: false }
    rtState.lastHash = hash

    const feedItems = watcher.config.format !== 'json' ? parseFeedItems(text) : []
    const emitted = []
    if (feedItems.length > 0) {
      const seen = new Set(rtState.seenIds ?? [])
      for (const item of feedItems.reverse()) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        if (!rtState.baselined) continue
        emitted.push({
          source: { kind: 'http', id: watcher.id, name: watcher.name, actor: watcher.config.url, actorTrusted: false },
          trust: 'external',
          threadKey: `http:${watcher.id}`,
          entityKey: `http:${watcher.id}:${item.id}`,
          eventType: 'http.feed_item',
          dedupeKey: `http:${watcher.id}:${item.id}`,
          summary: item.title,
          body: item.summary || item.link,
          meta: { url: item.link || watcher.config.url },
        })
      }
      rtState.seenIds = [...seen].slice(-200)
    } else if (rtState.baselined) {
      // Transition sequence guarantees repeated states (A -> B -> A) still notify.
      rtState.changeSeq = (rtState.changeSeq ?? 0) + 1
      emitted.push({
        source: { kind: 'http', id: watcher.id, name: watcher.name, actor: watcher.config.url, actorTrusted: false },
        trust: 'external',
        threadKey: `http:${watcher.id}`,
        entityKey: `http:${watcher.id}`,
        eventType: 'http.changed',
        dedupeKey: `http:${watcher.id}:seq${rtState.changeSeq}:${hash.slice(0, 12)}`,
        summary: `Updated: ${watcher.name}`,
        body: text.slice(0, 8000),
        meta: { url: watcher.config.url, hash: hash.slice(0, 16) },
      })
    }
    rtState.baselined = true
    return { events: emitted, changed: emitted.length > 0 }
  }

  async function probeFolder(watcher, rtState) {
    const dirPath = watcher.config.path
    const current = scanFolderSnapshot(dirPath)
    const prev = rtState.snapshot ?? {}
    const emitted = []

    if (rtState.baselined) {
      for (const [file, hash] of Object.entries(current)) {
        if (prev[file] === hash) continue
        const kind = prev[file] === undefined ? 'folder.created' : 'folder.modified'
        rtState.changeSeq = (rtState.changeSeq ?? 0) + 1
        emitted.push({
          source: { kind: 'folder', id: watcher.id, name: watcher.name, actor: 'filesystem', actorTrusted: false },
          trust: 'external',
          threadKey: `folder:${dirPath}`,
          entityKey: `folder:${join(dirPath, file)}`,
          eventType: kind,
          dedupeKey: `folder:${watcher.id}:${file}:seq${rtState.changeSeq}:${hash.slice(0, 12)}`,
          summary: `${kind === 'folder.created' ? 'New file' : 'File changed'}: ${file}`,
          body: `Path: ${join(dirPath, file)}`,
          meta: { dir: dirPath, file, path: join(dirPath, file) },
        })
      }
      for (const file of Object.keys(prev)) {
        if (current[file] !== undefined) continue
        rtState.changeSeq = (rtState.changeSeq ?? 0) + 1
        emitted.push({
          source: { kind: 'folder', id: watcher.id, name: watcher.name, actor: 'filesystem', actorTrusted: false },
          trust: 'external',
          threadKey: `folder:${dirPath}`,
          entityKey: `folder:${join(dirPath, file)}`,
          eventType: 'folder.deleted',
          dedupeKey: `folder:${watcher.id}:${file}:deleted:seq${rtState.changeSeq}`,
          summary: `File removed: ${file}`,
          body: `Path: ${join(dirPath, file)}`,
          meta: { dir: dirPath, file, path: join(dirPath, file) },
        })
      }
    }
    rtState.snapshot = current
    rtState.baselined = true
    return { events: emitted, changed: emitted.length > 0 }
  }

  async function probeMail(watcher, rtState) {
    const listMail = rt.config.events?.listMail ?? rt.listMailForWatcher
    if (typeof listMail !== 'function') {
      throw new Error('Connect a mail account in Settings → Connectors first')
    }
    const snapshot = await listMail(watcher.config)
    if (snapshot?.locked === true) return { events: [], skippedLocked: true }
    const { accountAddress, messages } = snapshot ?? {}
    const selfAddr = String(accountAddress ?? '').toLowerCase()
    const fromFilter = String(watcher.config.fromFilter ?? '').toLowerCase()
    const seen = new Set(rtState.seenIds ?? [])
    const emitted = []

    for (const msg of [...(messages ?? [])].reverse()) {
      const id = String(msg.uid ?? msg.id ?? '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      if (!rtState.baselined) continue
      const from = String(msg.from ?? '').toLowerCase()
      if (selfAddr && from.includes(selfAddr)) continue
      if (fromFilter && !from.includes(fromFilter)) continue
      const threadKey = `mail:${msg.threadId ?? msg.subject ?? id}`
      emitted.push({
        source: { kind: 'mail', id: watcher.id, name: watcher.name, actor: msg.from ?? '', actorTrusted: false },
        trust: 'external',
        threadKey,
        entityKey: threadKey,
        eventType: 'mail.received',
        dedupeKey: `mail:${watcher.id}:${id}`,
        summary: `Email from ${msg.from ?? 'unknown'}: ${msg.subject ?? '(no subject)'}`,
        body: msg.snippet ?? msg.body ?? '',
        meta: { uid: id, from: msg.from, subject: msg.subject, folder: watcher.config.folder },
      })
    }
    rtState.seenIds = [...seen].slice(-300)
    rtState.baselined = true
    return { events: emitted, changed: emitted.length > 0 }
  }

  async function probeCommand(watcher, rtState) {
    const result = await new Promise((resolveRun, rejectRun) => {
      execFile(watcher.config.executable, watcher.config.args ?? [], {
        cwd: watcher.config.cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
      }, (error, stdout, stderr) => {
        if (error && error.killed) return rejectRun(new Error('Command timed out'))
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolveRun({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })
    const combined = `exit=${result.code}\n${result.stdout}\n${result.stderr}`
    const hash = sha256(combined)
    if (rtState.lastHash === hash) return { events: [], changed: false }
    const emitted = []
    if (rtState.baselined) {
      rtState.changeSeq = (rtState.changeSeq ?? 0) + 1
      const rawBody = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n---\n')
      const safeBody = rt.redactSecrets ? rt.redactSecrets(rawBody) : rawBody
      emitted.push({
        source: { kind: 'command', id: watcher.id, name: watcher.name, actor: 'local-command', actorTrusted: false },
        trust: 'external',
        threadKey: `command:${watcher.id}`,
        entityKey: `command:${watcher.id}`,
        eventType: 'command.changed',
        dedupeKey: `command:${watcher.id}:seq${rtState.changeSeq}:${hash.slice(0, 12)}`,
        summary: `${watcher.name} output changed (exit ${result.code})`,
        body: safeBody.slice(0, 8000),
        meta: { exitCode: result.code },
      })
    }
    rtState.lastHash = hash
    rtState.baselined = true
    return { events: emitted, changed: emitted.length > 0 }
  }

  async function checkNow(id) {
    if (!writes()) throw invalid('Team is read-only in this window')
    const watcher = sources.find(w => w.id === id)
    if (!watcher) throw invalid('Unknown watcher')
    if (inFlight.has(id)) return { skipped: true }
    inFlight.add(id)
    // Snapshot prior checkpoint so failed event intake never advances the saved cursor.
    const prevState = readRuntime(id)
    const nextState = structuredClone(prevState)
    try {
      let result
      if (watcher.kind === 'github') result = await probeGithub(watcher, nextState)
      else if (watcher.kind === 'http') result = await probeHttp(watcher, nextState)
      else if (watcher.kind === 'folder') result = await probeFolder(watcher, nextState)
      else if (watcher.kind === 'mail') result = await probeMail(watcher, nextState)
      else if (watcher.kind === 'command') result = await probeCommand(watcher, nextState)
      else throw invalid(`Unsupported watcher kind: ${watcher.kind}`)

      if (result.skippedLocked) {
        return { checked: false, skippedLocked: true, count: 0 }
      }

      const privateBotId = isWatcherPrivate(watcher) ? watcher.target.botId : undefined
      for (const ev of result.events) {
        await onEvent?.(ev, { watcher, privateBotId })
      }

      // Commit checkpoint only after every event in the batch is durably persisted.
      nextState.errorCount = 0
      nextState.lastError = null
      nextState.lastCheckedAt = Date.now()
      saveRuntime(id, nextState)
      return { checked: true, count: result.events.length, baselined: nextState.baselined }
    } catch (error) {
      const msg = rt.redactSecrets ? rt.redactSecrets(error?.message ?? String(error)) : String(error?.message ?? error)
      // Preserve the previous checkpoint on error so unrecorded events are retried next run.
      prevState.errorCount = (prevState.errorCount ?? 0) + 1
      prevState.lastError = msg.slice(0, 300)
      prevState.lastCheckedAt = Date.now()
      if (error?.authFailed || prevState.errorCount >= MAX_CONSECUTIVE_ERRORS) {
        watcher.enabled = false
        watcher.updatedAt = Date.now()
        prevState.pausedReason = error?.authFailed ? `Authentication required: ${prevState.lastError}` : `Paused after ${prevState.errorCount} consecutive errors: ${prevState.lastError}`
        saveSources()
        unschedule(id)
        await onAlert?.({
          kind: 'watcher_paused',
          watcherId: watcher.id,
          watcherName: watcher.name,
          sourceKind: watcher.kind,
          target: watcher.target,
          reason: prevState.pausedReason,
          authFailed: Boolean(error?.authFailed),
        })
      }
      saveRuntime(id, prevState)
      return { checked: false, error: prevState.lastError, paused: !watcher.enabled }
    } finally {
      inFlight.delete(id)
    }
  }

  function unschedule(id) {
    const timer = timers.get(id)
    if (timer) clearInterval(timer)
    timers.delete(id)
    const fsw = fsWatchers.get(id)
    if (fsw) {
      try { fsw.close() } catch {}
      fsWatchers.delete(id)
    }
    const deb = folderDebounce.get(id)
    if (deb) clearTimeout(deb)
    folderDebounce.delete(id)
  }

  function reschedule(watcher) {
    unschedule(watcher.id)
    if (!writes() || !watcher.enabled) return
    if (rt.config.events?.disableTimers === true) return

    const timer = setInterval(() => {
      void checkNow(watcher.id).catch(() => {})
    }, watcher.intervalSec * 1000)
    timer.unref?.()
    timers.set(watcher.id, timer)

    if (watcher.kind === 'folder') {
      try {
        const fsw = fsWatch(watcher.config.path, () => {
          const prev = folderDebounce.get(watcher.id)
          if (prev) clearTimeout(prev)
          const t = setTimeout(() => {
            folderDebounce.delete(watcher.id)
            void checkNow(watcher.id).catch(() => {})
          }, FOLDER_DEBOUNCE_MS)
          t.unref?.()
          folderDebounce.set(watcher.id, t)
        })
        fsWatchers.set(watcher.id, fsw)
      } catch { /* fallback to interval polling */ }
    }
  }

  function startAll() {
    if (!writes()) return
    const loaded = readJson(sourcesPath, [])
    if (Array.isArray(loaded)) sources = loaded
    for (const watcher of sources) reschedule(watcher)
  }

  function dispose() {
    for (const id of [...timers.keys(), ...fsWatchers.keys()]) unschedule(id)
  }

  return {
    listWatchers,
    saveWatcher,
    toggleWatcher,
    deleteWatcher,
    checkNow,
    startAll,
    dispose,
  }
}
