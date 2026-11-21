// Phone link: the computer's end of the DS Bot phone app. A paired phone calls the same
// api/bot endpoints as this window, end to end encrypted through a Relay Server that only
// forwards (link/). The computer only connects out, so it needs no open port.
//
// phone.json keeps this computer's identity key, its Server token and the paired phones.
// Only the dsh that owns the team runs the link: two would push each other off the Server.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry, HostLink, LINK_PATH, deviceIdFor, generateKeyPair, pairingUri, randomToken } from '../../link.js'
import { BROWSER_ALLOWED } from '../shared/browser-endpoints.js'

const FILE = 'phone.json'
const SERVER = /^wss?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i
export const DEFAULT_SERVER = `wss://relay.dsbot.app${LINK_PATH}`
export { BROWSER_ALLOWED }

export function remoteAccessError(device, endpoint) {
  if (device === undefined) return { code: 'bot/refused', message: 'This device is not paired', details: {} }
  if (endpoint.startsWith('phone-')) return { code: 'bot/refused', message: 'Phones are paired and removed on the computer', details: {} }
  if (device.kind !== 'phone' && !BROWSER_ALLOWED.has(endpoint)) {
    return { code: 'bot/refused', message: 'Not available from a browser. Use the phone app or the computer.', details: {} }
  }
  if (endpoint.startsWith('mcp-')) return { code: 'bot/refused', message: 'MCP access is set up on the computer', details: {} }
  return undefined
}

// A browser may not open DSH Agent chats, so it may not read their media either.
const AGENT_MEDIA = new Set(['image', 'file-download', 'markdown-image'])
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

function remoteState(state) {
  if (!state?.phone || !Object.hasOwn(state.phone, 'pairing')) return state
  const phone = { ...state.phone }
  delete phone.pairing
  return { ...state, phone }
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
  const agentMediaError = (device, endpoint, payload) =>
    device.kind !== 'phone' && AGENT_MEDIA.has(endpoint) && rt.agentOf?.(String(payload?.sessionId ?? '')) !== undefined
      ? { code: 'bot/refused', message: 'Not available from a browser. Use the phone app or the computer.', details: {} }
      : undefined
  const callBot = async (params, signal, deviceId) => {
    const endpoint = String(params?.endpoint ?? '')
    // Fail closed if the calling device is missing, unknown, or was revoked.
    const device = typeof deviceId === 'string' && deviceId !== ''
      ? registry.list().find(entry => entry.deviceId === deviceId)
      : undefined
    const denied = remoteAccessError(device, endpoint) ?? agentMediaError(device, endpoint, params?.payload)
    if (denied !== undefined) return { ok: false, error: denied }
    const wanted = params?.state !== null && typeof params?.state === 'object' && !Array.isArray(params.state) ? params.state : undefined
    const before = rt.state.revision
    const answer = await serve(endpoint, params?.payload ?? null, signal)
    const result = endpoint === 'state' && answer?.ok === true ? { ...answer, value: remoteState(answer.value) } : answer
    if (wanted === undefined || result?.ok !== true || rt.state.revision === before) return result
    const state = await serve('state', wanted, signal).then(answer => (answer?.ok === true ? answer.value : undefined), () => undefined)
    return state === undefined ? result : { ...result, state: remoteState(state) }
  }

  const stop = () => {
    const running = link
    link = null
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
      // Feed events ride the link instead of SSE, but only while a phone is
      // actually ready to hear them — no tunnel, no feed work on the host.
      onReadyCount: count => {
        if (count > 0 && feedUntap === null) {
          const running = link
          feedUntap = rt.feedTap((event, data) => running.emit(event, event === 'live' ? remoteState(data) : data))
        } else if (count === 0 && feedUntap !== null) {
          feedUntap()
          feedUntap = null
        }
      },
    })
    linkServer = serverUrl()
    link.start()
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
      phones: registry.list().map(({ deviceId, name, pairedAt, kind }) => ({ id: deviceId, name, pairedAt, kind, connected: connected.has(deviceId) })),
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
        link?.disconnect(id)
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
