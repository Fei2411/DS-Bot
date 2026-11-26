// Phone link: the computer's end of the DS Bot phone app. A paired phone calls the same
// api/bot endpoints as this window, end to end encrypted through a Relay Server that only
// forwards (link/). The computer only connects out, so it needs no open port.
//
// phone.json keeps this computer's identity key, its Server token and the paired phones.
// Only the dsh that owns the team runs the link: two would push each other off the Server.
import { lookup as dnsLookup } from 'node:dns/promises'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  DeviceRegistry,
  HostLink,
  LINK_PATH,
  deviceIdFor,
  generateKeyPair,
  isPublicIpAddress,
  isUrgentNoticeKind,
  isValidPushEndpoint,
  pairingUri,
  randomToken,
  sealPushEnvelope,
} from '../../link.js'
import { BROWSER_ALLOWED } from '../shared/browser-endpoints.js'

const FILE = 'phone.json'
const SERVER = /^wss?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i
const MAX_PUSH_QUEUE = 16
const PUSH_TIMEOUT_MS = 5_000
const PUSH_TEXT_MAX_BYTES = 600
const PUSH_NAME_MAX_BYTES = 120
const PUSH_HOST_MAX_BYTES = 80
export const DEFAULT_SERVER = `wss://relay.dsbot.app${LINK_PATH}`
export { BROWSER_ALLOWED }

function trimUtf8(value, maxBytes) {
  const str = String(value ?? '')
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str
  let out = ''
  let used = 0
  for (const ch of str) {
    const bytes = Buffer.byteLength(ch, 'utf8')
    if (used + bytes > maxBytes) break
    out += ch
    used += bytes
  }
  return out
}

export async function resolveVerifiedPushAddresses(hostname, lookupFn = dnsLookup) {
  const entries = await lookupFn(hostname, { all: true, verbatim: true })
  if (!Array.isArray(entries) || entries.length === 0) return []
  if (!entries.every(entry => isPublicIpAddress(entry.address))) {
    throw new Error('Push endpoint resolved to a non-public address')
  }
  return entries.map(({ address, family }) => ({ address, family }))
}

async function postUnifiedPush(endpoint, bodyText, urgency, signal, allowLoopbackHttp, lookupFn = dnsLookup) {
  if (!isValidPushEndpoint(endpoint, { allowLoopbackHttp })) return { status: 0 }
  const parsed = new URL(endpoint)
  const isLoopbackTest = allowLoopbackHttp && parsed.protocol === 'http:'
  const hostBare = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname
  let resolvedList
  if (isLoopbackTest) {
    resolvedList = [{ address: hostBare === 'localhost' ? '127.0.0.1' : hostBare, family: hostBare.includes(':') ? 6 : 4 }]
  } else {
    resolvedList = await resolveVerifiedPushAddresses(hostBare, lookupFn)
    if (resolvedList.length === 0) return { status: 0 }
  }

  const body = Buffer.from(bodyText, 'utf8')
  const transport = parsed.protocol === 'https:' ? httpsRequest : httpRequest
  const combined = AbortSignal.any([signal, AbortSignal.timeout(PUSH_TIMEOUT_MS)])
  return new Promise((resolve, reject) => {
    if (combined.aborted) { reject(new Error('Push aborted')); return }
    const req = transport(parsed, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
        ttl: '86400',
        urgency,
      },
      // Return every verified public IP when Node requests `{ all: true }` so Happy Eyeballs
      // can fall back from IPv6 to IPv4 on dual-stack hosts without risking DNS rebinding.
      lookup: (_host, opts, cb) => {
        if (typeof opts === 'function') { opts(null, resolvedList[0].address, resolvedList[0].family); return }
        if (opts && opts.all) { cb(null, resolvedList.map(entry => ({ ...entry }))); return }
        cb(null, resolvedList[0].address, resolvedList[0].family)
      },
    }, (res) => {
      const status = res.statusCode ?? 0
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve({ status })
      }
      res.resume()
      res.once('end', done)
      res.once('close', done)
      res.once('error', done)
    })
    const onAbort = () => { req.destroy(new Error('Push aborted')) }
    combined.addEventListener('abort', onAbort, { once: true })
    req.once('close', () => combined.removeEventListener('abort', onAbort))
    req.once('error', reject)
    req.end(body)
  })
}

export function remoteAccessError(device, endpoint) {
  if (device === undefined) return { code: 'bot/refused', message: 'This device is not paired', details: {} }
  if (endpoint.startsWith('phone-')) return { code: 'bot/refused', message: 'Phones are paired and removed on the computer', details: {} }
  // A Session's whole log, any Session's (session-follow.js), is read by the window on the
  // computer; a phone reads the team's chats.
  if (endpoint.startsWith('session-')) return { code: 'bot/refused', message: 'Session logs are read on the computer', details: {} }
  if (endpoint.startsWith('api-')) return { code: 'bot/refused', message: 'External API settings and tokens are managed on the computer', details: {} }
  if (device.kind !== 'phone' && !BROWSER_ALLOWED.has(endpoint)) {
    return { code: 'bot/refused', message: 'Not available from a browser. Use the phone app or the computer.', details: {} }
  }
  if (endpoint.startsWith('mcp-')) return { code: 'bot/refused', message: 'MCP access is set up on the computer', details: {} }
  if (endpoint.startsWith('workspace-') || endpoint.startsWith('terminal-')) {
    return { code: 'bot/refused', message: 'Workspace files and terminals are available on the computer', details: {} }
  }
  if (endpoint.startsWith('engine-')) {
    return { code: 'bot/refused', message: 'Engine settings are managed on the computer', details: {} }
  }
  if (endpoint.startsWith('plugins-')) {
    return { code: 'bot/refused', message: 'Plugins are managed on the computer', details: {} }
  }
  if (endpoint.startsWith('speech-')) {
    return { code: 'bot/refused', message: 'Voice input settings and transcription are available on the computer', details: {} }
  }
  if (endpoint.startsWith('telemetry-')) {
    return { code: 'bot/refused', message: 'Privacy and telemetry settings are managed on the computer', details: {} }
  }
  return undefined
}

// A browser may not open DSH Agent chats, so it may not read their media or answer their approvals either.
const AGENT_MEDIA = new Set(['image', 'file-download', 'markdown-image'])
const BROWSER_DENIED = { code: 'bot/refused', message: 'Not available from a browser. Use the phone app or the computer.', details: {} }
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

export function remoteState(state, { browser = false } = {}) {
  if (!state || typeof state !== 'object') return state
  let next = state
  if (Object.hasOwn(next, 'userQuestions') || Object.hasOwn(next, 'sessionQueues')) {
    next = { ...next }
    delete next.userQuestions
    delete next.sessionQueues
  }
  if (next.phone && Object.hasOwn(next.phone, 'pairing')) {
    const phone = { ...next.phone }
    delete phone.pairing
    next = { ...next, phone }
  }
  if (browser && Array.isArray(next.work?.approvals)) {
    const approvals = next.work.approvals.filter(entry => entry?.botId !== undefined)
    if (approvals.length !== next.work.approvals.length) {
      next = { ...next, work: { ...next.work, approvals } }
    }
  }
  return next
}

function remoteFolders(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'data')) return value
  const copy = { ...value }
  delete copy.data
  return copy
}

export function install(rt) {
  const path = join(rt.home, FILE)
  let data
  let registry
  let link = null
  let feedUntap = null
  let linkServer
  let serve = null
  let pairing = null
  let blocked
  let readyCount = 0
  const pushQueues = new Map()
  const pushDraining = new Set()
  let pushAbort = new AbortController()

  const hasPushDevices = () => registry?.list().some(entry => entry.kind === 'phone' && entry.push !== undefined) === true

  const clearPushQueue = (deviceId) => {
    pushQueues.delete(deviceId)
  }

  const deliverPush = async (device, notice, urgency, signal) => {
    const hostIdentity = identity()
    const boot = rt.noticeCursor?.()?.boot
    const compactNotice = {
      ...notice,
      name: trimUtf8(notice.name, PUSH_NAME_MAX_BYTES),
      text: trimUtf8(notice.text, PUSH_TEXT_MAX_BYTES),
      ...(notice.title !== undefined ? { title: trimUtf8(notice.title, PUSH_NAME_MAX_BYTES) } : {}),
    }
    const envelope = sealPushEnvelope(hostIdentity.privateKey, hostIdentity.publicKey, device.identityKey, {
      hostName: trimUtf8(hostname(), PUSH_HOST_MAX_BYTES),
      ...(typeof boot === 'string' ? { boot } : {}),
      notice: compactNotice,
    })
    if (device.push.kind === 'unifiedpush') {
      const bodyText = JSON.stringify(envelope)
      let status = 0
      if (typeof rt.pushFetch === 'function') {
        const response = await rt.pushFetch(device.push.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ttl: '86400', urgency },
          body: bodyText,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(PUSH_TIMEOUT_MS)]),
        })
        status = response.status
        await response.body?.cancel?.().catch(() => {})
      } else {
        const res = await postUnifiedPush(
          device.push.endpoint,
          bodyText,
          urgency,
          signal,
          rt.pushAllowLoopbackHttp === true,
          rt.pushLookup ?? dnsLookup,
        )
        status = res.status
      }
      if (status === 404 || status === 410) {
        registry?.setPush(device.deviceId, undefined)
        clearPushQueue(device.deviceId)
        reconcileFeed()
      }
    }
  }

  const drainPushQueue = (deviceId) => {
    if (pushDraining.has(deviceId)) return
    pushDraining.add(deviceId)
    void (async () => {
      try {
        while (true) {
          const queue = pushQueues.get(deviceId)
          if (!queue || queue.length === 0) {
            pushQueues.delete(deviceId)
            return
          }
          const item = queue.shift()
          const current = registry?.list().find(entry => entry.deviceId === deviceId)
          if (current?.push === undefined || link === null) {
            pushQueues.delete(deviceId)
            return
          }
          const connectedNow = new Set(link.connectedDevices())
          if (connectedNow.has(deviceId)) continue
          try {
            await deliverPush(current, item.notice, item.urgency, pushAbort.signal)
          } catch {
            /* offline push is best-effort; notices endpoint catches up on reconnect */
          }
        }
      } finally {
        pushDraining.delete(deviceId)
      }
    })()
  }

  const enqueueOfflinePushes = (notice) => {
    if (link === null || notice === null || typeof notice !== 'object') return
    const connectedNow = new Set(link.connectedDevices())
    const urgency = isUrgentNoticeKind(notice.kind) ? 'high' : 'normal'
    for (const device of registry?.list() ?? []) {
      if (device.kind !== 'phone' || device.push === undefined || connectedNow.has(device.deviceId)) continue
      let queue = pushQueues.get(device.deviceId)
      if (queue === undefined) {
        queue = []
        pushQueues.set(device.deviceId, queue)
      }
      if (queue.length >= MAX_PUSH_QUEUE) {
        const dropIndex = queue.findIndex(entry => entry.urgency !== 'high')
        queue.splice(dropIndex >= 0 ? dropIndex : 0, 1)
      }
      queue.push({ notice, urgency })
      drainPushQueue(device.deviceId)
    }
  }

  const reconcileFeed = () => {
    const running = link
    const wantFeed = running !== null && (readyCount > 0 || hasPushDevices())
    if (wantFeed && feedUntap === null) {
      feedUntap = rt.feedTap((event, payload) => {
        if (event === 'terminal' || event === 'terminal-exit') return
        if (readyCount > 0) {
          if (event === 'live') {
            running.emit(event, remoteState(payload, { browser: true }), (targetDeviceId) => {
              const target = registry.list().find(entry => entry.deviceId === targetDeviceId)
              return remoteState(payload, { browser: target?.kind !== 'phone' })
            })
          } else {
            running.emit(event, payload)
          }
        }
        if (event === 'notice') enqueueOfflinePushes(payload)
      })
    } else if (!wantFeed && feedUntap !== null) {
      feedUntap()
      feedUntap = null
    }
  }

  const read = () => {
    if (data !== undefined) return data
    try { data = JSON.parse(readFileSync(path, 'utf8')) } catch { data = {} }
    if (!Array.isArray(data.devices)) data.devices = []
    registry = new DeviceRegistry(data.devices, (devices) => { data.devices = devices; write() })
    return data
  }
  const write = () => {
    mkdirSync(rt.home, { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  }
  // An empty address means the DS Bot relay; a user's own Server replaces it.
  const serverUrl = () => data.server || DEFAULT_SERVER
  const identity = () => {
    const keys = data.identity
    try {
      if (keys && deviceIdFor(keys.publicKey) === keys.deviceId && typeof keys.privateKey === 'string' && typeof data.accessToken === 'string') return keys
    } catch { /* a broken key is made again */ }
    const fresh = generateKeyPair()
    data.identity = { deviceId: deviceIdFor(fresh.publicKey), ...fresh }
    data.accessToken = randomToken()
    data.devices = []
    registry = new DeviceRegistry([], (devices) => { data.devices = devices; write() })
    write()
    return data.identity
  }

  // A phone may call every endpoint but these: pairing stays on the computer.
  // When the call carries `state` (the payload the phone would send `state`) and
  // it moved the team, the reply carries the new state too — one round trip
  // through the relay instead of waiting for the revision event and a read.
  const agentApprovalDenied = (endpoint, payload) => {
    if (endpoint !== 'approval-answer') return false
    const id = String(payload?.id ?? '')
    if (id === '') return false
    const entry = rt.approvalById?.(id) ?? rt.approvalsView?.()?.find(item => item.id === id)
    return entry !== undefined && (entry.botId === undefined || rt.agentOf?.(entry.sessionId) !== undefined)
  }
  const agentAccessError = (device, endpoint, payload) =>
    device.kind !== 'phone'
    && ((AGENT_MEDIA.has(endpoint) && rt.agentOf?.(String(payload?.sessionId ?? '')) !== undefined)
      || agentApprovalDenied(endpoint, payload))
      ? BROWSER_DENIED
      : undefined
  const callBot = async (params, signal, deviceId) => {
    const endpoint = String(params?.endpoint ?? '')
    // Fail closed if the calling device is missing, unknown, or was revoked.
    const device = typeof deviceId === 'string' && deviceId !== ''
      ? registry.list().find(entry => entry.deviceId === deviceId)
      : undefined
    const denied = remoteAccessError(device, endpoint) ?? agentAccessError(device, endpoint, params?.payload)
    if (denied !== undefined) return { ok: false, error: denied }
    const browser = device.kind !== 'phone'
    if (endpoint === 'push-register') {
      const payload = params?.payload ?? {}
      if (payload?.kind !== 'unifiedpush') {
        return { ok: false, error: { code: 'bot/invalid', message: 'Push kind must be unifiedpush', details: {} } }
      }
      if (!isValidPushEndpoint(payload?.endpoint, { allowLoopbackHttp: rt.pushAllowLoopbackHttp === true })) {
        return { ok: false, error: { code: 'bot/invalid', message: 'Push endpoint must be a valid https:// URL', details: {} } }
      }
      registry.setPush(device.deviceId, { kind: 'unifiedpush', endpoint: payload.endpoint, updatedAt: Date.now() })
      reconcileFeed()
      return { ok: true, value: { registered: true, kind: 'unifiedpush' } }
    }
    if (endpoint === 'push-unregister') {
      registry.setPush(device.deviceId, undefined)
      clearPushQueue(device.deviceId)
      reconcileFeed()
      return { ok: true, value: { registered: false } }
    }
    const wanted = params?.state !== null && typeof params?.state === 'object' && !Array.isArray(params.state) ? params.state : undefined
    const before = rt.state.revision
    const answer = await serve(endpoint, params?.payload ?? null, signal)
    const result = endpoint === 'state' && answer?.ok === true
      ? { ...answer, value: remoteState(answer.value, { browser }) }
      : endpoint === 'folders' && answer?.ok === true
        ? { ...answer, value: remoteFolders(answer.value) }
        : answer
    if (wanted === undefined || result?.ok !== true || rt.state.revision === before) return result
    const state = await serve('state', wanted, signal).then(answer => (answer?.ok === true ? answer.value : undefined), () => undefined)
    return state === undefined ? result : { ...result, state: remoteState(state, { browser }) }
  }

  const stop = () => {
    const running = link
    link = null
    readyCount = 0
    pushAbort.abort()
    pushAbort = new AbortController()
    pushQueues.clear()
    feedUntap?.()
    feedUntap = null
    return running?.stop()
  }
  const reconcile = () => {
    read()
    blocked = !data.on ? undefined
      : rt.readOnly() !== undefined ? 'Another dsh has this Bot team open, so phones connect to that one'
        : typeof WebSocket !== 'function' ? 'This dsh runs on a Node without WebSocket'
          : undefined
    const want = data.on === true && serve !== null && blocked === undefined
    if (link !== null && (!want || linkServer !== serverUrl())) void stop()
    if (!want || link !== null) return
    link = new HostLink({
      url: serverUrl(),
      identity: identity(),
      accessToken: data.accessToken,
      name: hostname(),
      admits: (deviceId, key) => registry.admits(deviceId, key),
      authorize: (deviceId, key, hello) => registry.authorize(deviceId, key, hello),
      handle: (method, params, request) => method === 'bot' ? callBot(params, request.signal, request.deviceId) : Promise.reject(Object.assign(new Error(`Unknown method ${method}`), { code: 'METHOD_NOT_FOUND' })),
      // Feed events ride the link while a phone is connected, and also when an
      // offline phone has an E2E push subscription registered.
      onReadyCount: count => {
        readyCount = count
        reconcileFeed()
      },
    })
    linkServer = serverUrl()
    link.start()
    reconcileFeed()
  }

  rt.phoneView = () => {
    reconcile()
    if (pairing !== null && !registry.pairingOpen()) pairing = null
    const connected = new Set(link?.connectedDevices() ?? [])
    const reason = blocked ?? link?.error
    return {
      server: serverUrl(),
      on: data.on === true,
      status: link?.status ?? 'off',
      ...(reason === undefined ? {} : { error: reason }),
      phones: registry.list().map(({ deviceId, name, pairedAt, kind, push }) => ({
        id: deviceId,
        name,
        pairedAt,
        kind,
        connected: connected.has(deviceId),
        ...(push !== undefined ? { push: { kind: push.kind } } : {}),
      })),
      pairing,
    }
  }

  rt.phoneEndpoint = async (endpoint, body) => {
    read()
    switch (endpoint) {
      case 'phone-set': {
        if (body.server !== undefined) {
          const entered = String(body.server).trim().replace(/\/+$/, '')
          if (entered !== '' && !SERVER.test(entered)) throw invalid('The Server address must start with ws:// or wss://')
          // A bare host means this relay; the Server only serves LINK_PATH.
          const server = entered !== '' && new URL(entered).pathname === '/' ? entered + LINK_PATH : entered
          data.server = server
          pairing = null
          registry?.closePairing()
        }
        if (body.on !== undefined) data.on = body.on === true
        identity()
        write()
        break
      }
      case 'phone-pair': {
        reconcile()
        if (link === null) throw invalid(blocked ?? 'Turn on phone access first')
        const { code, browserCode, expiresAt } = registry.openPairing()
        const offer = { server: serverUrl(), hostDeviceId: data.identity.deviceId, hostKey: data.identity.publicKey, name: hostname() }
        pairing = { uri: pairingUri({ ...offer, code }), browserUri: pairingUri({ ...offer, code: browserCode, device: 'browser' }), expiresAt }
        break
      }
      case 'phone-pair-cancel':
        registry.closePairing()
        pairing = null
        break
      case 'phone-remove': {
        const id = String(body.id ?? '')
        if (!registry.revoke(id)) throw invalid('This phone is not paired')
        clearPushQueue(id)
        link?.disconnect(id)
        reconcileFeed()
        break
      }
      default:
        throw invalid(`Unknown endpoint ${endpoint}`)
    }
    return rt.phoneView()
  }

  // channel.js hands over its endpoint handler once it has one.
  rt.phoneServe = (handle) => {
    serve = handle
    rt.ctx.effect(() => {
      void rt.load().then(reconcile, () => {})
      return () => stop()
    }, 'ds-bot: phone link')
  }
}
