// Mechanical Watchers: zero-token polling and folder watchers run only by the host that
// holds state.lock. Supports github (ETag 304), mail, folder, https/rss, and user-only
// local command probes. Built-in guardrails: first-run baseline (never floods old items),
// self-trigger filtering, consecutive-error/401 auto-pause, and private-Bot isolation.
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, watch as fsWatch, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const WATCHER_KINDS = new Set(['github', 'mail', 'folder', 'http', 'command'])
const MIN_INTERVAL_SEC = 15
const DEFAULT_INTERVALS = { github: 60, mail: 60, folder: 30, http: 300, command: 60 }
const MAX_CONSECUTIVE_ERRORS = 5
const FETCH_TIMEOUT_MS = 15_000
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

function isDisallowedHttpUrl(raw) {
  let parsed
  try { parsed = new URL(String(raw ?? '')) } catch { return 'Enter a valid https:// URL' }
  if (parsed.protocol !== 'https:') return 'HTTP watchers only allow https:// URLs'
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.') || host.startsWith('169.254.') || host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return 'HTTP watchers cannot target loopback or private network addresses'
  }
  return null
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
      // Hash small text files directly; fall back to size+mtime for large binaries.
      if (st.size <= 256 * 1024) {
        snapshot[entry.name] = sha256(readFileSync(full))
      } else {
        snapshot[entry.name] = `${st.size}:${Math.floor(st.mtimeMs)}`
      }
    } catch { /* file vanished mid-scan */ }
  }
  return snapshot
}

export function createWatchers(rt, { onEvent, onAlert } = {}) {
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

  function validateKindConfig(kind, config, { isUser }) {
    const cfg = config && typeof config === 'object' ? { ...config } : {}
    if (kind === 'command' && !isUser) {
      throw invalid('Only the user can create or change local command watchers')
    }
    if (kind === 'github') {
      const repo = String(cfg.repo ?? '').trim()
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw invalid('GitHub watcher needs repo in owner/name format')
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
      return { path: resolve(path) }
    }
    if (kind === 'http') {
      const url = String(cfg.url ?? '').trim()
      const err = rt.config.events?.allowInsecureHttp ? null : isDisallowedHttpUrl(url)
      if (err) throw invalid(err)
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

  function saveWatcher(input, { isUser = false, callerBotId } = {}) {
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
    const config = validateKindConfig(kind, input.config ?? existing?.config, { isUser })
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

  // --- Probe implementations -------------------------------------------

  const fetchImpl = () => rt.config.events?.fetch ?? globalThis.fetch

  async function probeGithub(watcher, rtState) {
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

    // Resolve self login once so bot/user's own comments never cause a self-trigger loop.
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

    // Process oldest to newest so timeline order matches reality.
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
        dedupeKey: `github:${watcher.config.repo}:${id}`,
        summary: `${item.actor?.login ?? 'someone'} · ${item.type}${num !== undefined ? ` #${num}` : ''}: ${title}`,
        body,
        meta: { repo: watcher.config.repo, number: num, url },
      })
    }

    rtState.seenIds = [...seen].slice(-200)
    rtState.baselined = true
    return { events: emitted, changed: emitted.length > 0 }
  }

  async function probeHttp(watcher, rtState) {
    const headers = { 'User-Agent': 'ds-bot' }
    if (rtState.etag) headers['If-None-Match'] = rtState.etag
    if (rtState.lastModified) headers['If-Modified-Since'] = rtState.lastModified
    const res = await fetchImpl()(watcher.config.url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (res.status === 304) return { events: [], changed: false }
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`HTTP source refused access (${res.status})`), { authFailed: true })
    }
    if (!res.ok) throw new Error(`HTTP source returned ${res.status}`)

    const etag = res.headers.get('etag')
    const lastMod = res.headers.get('last-modified')
    if (etag) rtState.etag = etag
    if (lastMod) rtState.lastModified = lastMod

    const text = await res.text()
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
      emitted.push({
        source: { kind: 'http', id: watcher.id, name: watcher.name, actor: watcher.config.url, actorTrusted: false },
        trust: 'external',
        threadKey: `http:${watcher.id}`,
        entityKey: `http:${watcher.id}`,
        eventType: 'http.changed',
        dedupeKey: `http:${watcher.id}:${hash.slice(0, 16)}`,
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
        emitted.push({
          source: { kind: 'folder', id: watcher.id, name: watcher.name, actor: 'filesystem', actorTrusted: false },
          trust: 'external',
          threadKey: `folder:${dirPath}`,
          entityKey: `folder:${join(dirPath, file)}`,
          eventType: kind,
          dedupeKey: `folder:${watcher.id}:${file}:${hash.slice(0, 16)}`,
          summary: `${kind === 'folder.created' ? 'New file' : 'File changed'}: ${file}`,
          body: `Path: ${join(dirPath, file)}`,
          meta: { dir: dirPath, file, path: join(dirPath, file) },
        })
      }
      for (const file of Object.keys(prev)) {
        if (current[file] !== undefined) continue
        emitted.push({
          source: { kind: 'folder', id: watcher.id, name: watcher.name, actor: 'filesystem', actorTrusted: false },
          trust: 'external',
          threadKey: `folder:${dirPath}`,
          entityKey: `folder:${join(dirPath, file)}`,
          eventType: 'folder.deleted',
          dedupeKey: `folder:${watcher.id}:${file}:deleted:${Date.now()}`,
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
    // Uses injected mail fetcher in tests or host mail helper if connected.
    const listMail = rt.config.events?.listMail ?? rt.listMailForWatcher
    if (typeof listMail !== 'function') {
      throw new Error('Connect a mail account in Settings → Connectors first')
    }
    const { accountAddress, messages } = await listMail(watcher.config)
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
      const rawBody = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n---\n')
      const safeBody = rt.redactSecrets ? rt.redactSecrets(rawBody) : rawBody
      emitted.push({
        source: { kind: 'command', id: watcher.id, name: watcher.name, actor: 'local-command', actorTrusted: false },
        trust: 'external',
        threadKey: `command:${watcher.id}`,
        entityKey: `command:${watcher.id}`,
        eventType: 'command.changed',
        dedupeKey: `command:${watcher.id}:${hash.slice(0, 16)}`,
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
    const rtState = readRuntime(id)
    try {
      let result
      if (watcher.kind === 'github') result = await probeGithub(watcher, rtState)
      else if (watcher.kind === 'http') result = await probeHttp(watcher, rtState)
      else if (watcher.kind === 'folder') result = await probeFolder(watcher, rtState)
      else if (watcher.kind === 'mail') result = await probeMail(watcher, rtState)
      else if (watcher.kind === 'command') result = await probeCommand(watcher, rtState)
      else throw invalid(`Unsupported watcher kind: ${watcher.kind}`)

      rtState.errorCount = 0
      rtState.lastError = null
      rtState.lastCheckedAt = Date.now()
      saveRuntime(id, rtState)

      const privateBotId = isWatcherPrivate(watcher) ? watcher.target.botId : undefined
      for (const ev of result.events) {
        await onEvent?.(ev, { watcher, privateBotId })
      }
      return { checked: true, count: result.events.length, baselined: rtState.baselined }
    } catch (error) {
      const msg = rt.redactSecrets ? rt.redactSecrets(error?.message ?? String(error)) : String(error?.message ?? error)
      rtState.errorCount = (rtState.errorCount ?? 0) + 1
      rtState.lastError = msg.slice(0, 300)
      rtState.lastCheckedAt = Date.now()
      if (error?.authFailed || rtState.errorCount >= MAX_CONSECUTIVE_ERRORS) {
        watcher.enabled = false
        watcher.updatedAt = Date.now()
        rtState.pausedReason = error?.authFailed ? `Authentication required: ${rtState.lastError}` : `Paused after ${rtState.errorCount} consecutive errors: ${rtState.lastError}`
        saveSources()
        unschedule(id)
        await onAlert?.({
          kind: 'watcher_paused',
          watcherId: watcher.id,
          watcherName: watcher.name,
          sourceKind: watcher.kind,
          target: watcher.target,
          reason: rtState.pausedReason,
          authFailed: Boolean(error?.authFailed),
        })
      }
      saveRuntime(id, rtState)
      return { checked: false, error: rtState.lastError, paused: !watcher.enabled }
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
