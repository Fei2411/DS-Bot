import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  MAX_CONTROL_FRAME_BYTES,
  MAX_RELAY_BYTES_PER_SECOND,
  MAX_RELAY_FRAMES_PER_SECOND,
  MAX_RELAY_FRAME_BYTES,
  PROTOCOL_VERSION,
  createControlFrame,
  decodeControlFrame,
  type ConnectRequestPayload,
  type ControlFrame,
  type HelloPayload,
  type RelayPayload,
  type SecureHandshakePayload,
} from '../src/frames.ts'
import { deviceIdFor } from '../src/keys.ts'
import { DeviceStore, LinkError } from './store.ts'

interface Peer {
  ws: WebSocket
  id: string
  role: 'host' | 'client'
  capabilities: string[]
  lastPong: number
  nonce?: string
}

interface Link {
  id: string
  host: string
  client: string
  stage: 'pending' | 'accepted' | 'handshake' | 'ready'
  created: number
  counters: Map<string, number>
}

export interface GatewayOptions {
  store: DeviceStore
  serverVersion: string
  maxSockets?: number
  maxLinks?: number
  /** Open sockets from one address. Phones behind carrier NAT share addresses, so keep this generous. */
  maxSocketsPerAddress?: number
  /** Devices one address may register per hour, so nobody can fill the device table. */
  maxNewDevicesPerHour?: number
  /** Bytes one address may send per hour, so nobody can turn the relay into a bulk tunnel. */
  maxBytesPerHour?: number
  /** Take the client address from the last X-Forwarded-For entry. Only behind a proxy that sets it. */
  trustProxy?: boolean
  /** Forget devices not seen for this long. */
  deviceTtlMs?: number
}

const RELAY_CAPABILITY = 'transport.relay'
const HEARTBEAT_MS = 25_000
const HOUR_MS = 3_600_000
const DEFAULT_MAX_BYTES_PER_HOUR = 512 * 1024 * 1024

/**
 * Pairs a phone's control socket with its computer's and forwards their frames.
 * It checks who may send what, in which order, but it cannot read the messages:
 * they are encrypted end to end.
 */
export class Gateway {
  private readonly peers = new Map<string, Peer>()
  private readonly links = new Map<string, Link>()
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RELAY_FRAME_BYTES, perMessageDeflate: false })
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly options: GatewayOptions
  private readonly sockets = new Map<string, number>()
  private readonly registrations = new Map<string, { start: number; count: number }>()
  private readonly traffic = new Map<string, { start: number; bytes: number }>()
  private lastPrune = 0

  constructor(options: GatewayOptions) {
    this.options = options
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS)
    this.heartbeat.unref()
    this.prune()
  }

  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const address = this.addressOf(req)
    const open = this.sockets.get(address) ?? 0
    if (this.wss.clients.size >= (this.options.maxSockets ?? 1024) || !sameOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    if (open >= (this.options.maxSocketsPerAddress ?? 256)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
      return
    }
    this.sockets.set(address, open + 1)
    // Count the TCP socket, not the WebSocket: a failed upgrade closes the socket without one.
    socket.once('close', () => this.release(address))
    this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws, address))
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const ws of this.wss.clients) ws.terminate()
    this.wss.close()
  }

  private addressOf(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for']
    if (this.options.trustProxy && typeof forwarded === 'string') {
      const last = forwarded.split(',').at(-1)?.trim()
      if (last) return last
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  private release(address: string): void {
    const open = (this.sockets.get(address) ?? 1) - 1
    if (open > 0) this.sockets.set(address, open)
    else this.sockets.delete(address)
  }

  private registerNew(address: string): void {
    const now = Date.now()
    let window = this.registrations.get(address)
    if (window === undefined || now - window.start >= HOUR_MS) {
      window = { start: now, count: 0 }
      this.registrations.set(address, window)
    }
    if (window.count >= (this.options.maxNewDevicesPerHour ?? 20)) throw new LinkError('RATE_LIMITED')
    window.count += 1
  }

  private chargeBytes(address: string, size: number): void {
    const now = Date.now()
    let window = this.traffic.get(address)
    if (window === undefined || now - window.start >= HOUR_MS) {
      window = { start: now, bytes: 0 }
      this.traffic.set(address, window)
    }
    window.bytes += size
    if (window.bytes > (this.options.maxBytesPerHour ?? DEFAULT_MAX_BYTES_PER_HOUR)) throw new LinkError('RATE_LIMITED')
  }

  private prune(): void {
    const now = Date.now()
    for (const [address, window] of this.registrations) if (now - window.start >= HOUR_MS) this.registrations.delete(address)
    for (const [address, window] of this.traffic) if (now - window.start >= HOUR_MS) this.traffic.delete(address)
    if (this.options.deviceTtlMs === undefined || now - this.lastPrune < HOUR_MS) return
    this.lastPrune = now
    this.options.store.prune(this.options.deviceTtlMs, now)
  }

  private beat(): void {
    this.prune()
    for (const peer of this.peers.values()) {
      if (Date.now() - peer.lastPong > 3 * HEARTBEAT_MS) { this.disconnect(peer.id, 'CONNECTION_FAILED'); continue }
      peer.nonce = randomUUID()
      this.send(peer, createControlFrame('ping', { nonce: peer.nonce }))
    }
    for (const link of this.links.values()) {
      if (link.stage !== 'ready' && Date.now() - link.created > 30_000) this.drop(link, 'CONNECTION_FAILED')
    }
  }

  private send(peer: Peer, frame: ControlFrame): void {
    if (peer.ws.readyState !== WebSocket.OPEN) return
    if (peer.ws.bufferedAmount > 4 * MAX_RELAY_FRAME_BYTES) { this.disconnect(peer.id, 'SLOW_CONSUMER'); return }
    peer.ws.send(JSON.stringify(frame))
  }

  private drop(link: Link, code: string): void {
    if (!this.links.delete(link.id)) return
    for (const id of [link.host, link.client]) {
      const peer = this.peers.get(id)
      if (peer !== undefined) this.send(peer, createControlFrame('error', { code, message: code, connectionId: link.id, retryable: true }))
    }
  }

  private disconnect(id: string, code: string): void {
    const peer = this.peers.get(id)
    this.peers.delete(id)
    for (const link of this.links.values()) if (link.host === id || link.client === id) this.drop(link, code)
    if (peer !== undefined) {
      peer.ws.close(code === 'CONNECTION_REPLACED' ? 4003 : 4001, code)
      setTimeout(() => peer.ws.terminate(), 1_000).unref()
    }
  }

  private accept(ws: WebSocket, address: string): void {
    let peer: Peer | undefined
    const deadline = setTimeout(() => ws.terminate(), 5_000)
    let windowStart = Date.now()
    let frames = 0
    let bytes = 0
    ws.on('error', () => {})
    ws.on('close', () => {
      clearTimeout(deadline)
      if (peer !== undefined && this.peers.get(peer.id) === peer) this.disconnect(peer.id, 'CONNECTION_FAILED')
    })
    ws.on('message', (raw: RawData, binary: boolean) => {
      if (ws.readyState !== WebSocket.OPEN) return
      let frame: ControlFrame | undefined
      try {
        if (binary) throw new LinkError('INVALID_MESSAGE')
        const text = raw.toString()
        const size = Buffer.byteLength(text)
        if (Date.now() - windowStart >= 1_000) { windowStart = Date.now(); frames = 0; bytes = 0 }
        if (++frames > MAX_RELAY_FRAMES_PER_SECOND || (bytes += size) > MAX_RELAY_BYTES_PER_SECOND) throw new LinkError('RATE_LIMITED')
        this.chargeBytes(address, size)
        frame = decodeControlFrame(text, { maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES, maxRelayFrameBytes: MAX_RELAY_FRAME_BYTES })
        if (peer === undefined) {
          peer = this.hello(ws, frame, address)
          clearTimeout(deadline)
          return
        }
        if (this.peers.get(peer.id) !== peer) throw new LinkError('AUTH_INVALID')
        this.handle(peer, frame)
      } catch (error) {
        const code = error instanceof LinkError ? error.code : 'INVALID_MESSAGE'
        // A fault in one link must not close the computer's other phones.
        const connectionId = (frame?.payload as { connectionId?: unknown } | undefined)?.connectionId
        if (peer !== undefined && typeof connectionId === 'string' && code !== 'RATE_LIMITED') {
          const link = this.links.get(connectionId)
          if (link !== undefined && (link.host === peer.id || link.client === peer.id)) this.drop(link, code)
          else this.send(peer, createControlFrame('error', { code, message: code, connectionId, retryable: false }))
          return
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(createControlFrame('error', { code, message: code, retryable: false })))
        if (peer !== undefined) this.disconnect(peer.id, code)
        else { ws.close(4001, code); setTimeout(() => ws.terminate(), 1_000).unref() }
      }
    })
  }

  private hello(ws: WebSocket, frame: ControlFrame, address: string): Peer {
    if (frame.type !== 'hello') throw new LinkError('AUTH_REQUIRED')
    const p = frame.payload as Partial<HelloPayload>
    if ((p.role !== 'host' && p.role !== 'client') || typeof p.deviceId !== 'string' || typeof p.identityKey !== 'string'
      || typeof p.accessToken !== 'string' || p.accessToken.length < 32 || p.accessToken.length > 256
      || !Array.isArray(p.protocols) || !Array.isArray(p.capabilities)
      || !p.capabilities.every(item => typeof item === 'string')) {
      throw new LinkError('AUTH_INVALID')
    }
    let derived: string | undefined
    try { derived = deviceIdFor(p.identityKey) } catch {}
    if (derived !== p.deviceId) throw new LinkError('AUTH_INVALID')
    if (!p.protocols.includes(PROTOCOL_VERSION)) throw new LinkError('UNSUPPORTED_VERSION')
    if (this.options.store.get(p.deviceId) === undefined) this.registerNew(address)
    this.options.store.admit(p.deviceId, p.role, p.identityKey, p.accessToken)
    this.disconnect(p.deviceId, 'CONNECTION_REPLACED')
    const peer: Peer = { ws, id: p.deviceId, role: p.role, capabilities: p.capabilities, lastPong: Date.now() }
    this.peers.set(peer.id, peer)
    this.send(peer, createControlFrame('hello.ack', {
      protocol: PROTOCOL_VERSION,
      serverVersion: this.options.serverVersion,
      connectionSessionId: randomUUID(),
      heartbeatIntervalMs: HEARTBEAT_MS,
      maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
      maxRelayFrameBytes: MAX_RELAY_FRAME_BYTES,
      capabilities: peer.capabilities.includes(RELAY_CAPABILITY) ? [RELAY_CAPABILITY] : [],
    }))
    return peer
  }

  private handle(peer: Peer, frame: ControlFrame): void {
    const p = frame.payload as Record<string, unknown>
    if (frame.type === 'ping') { this.send(peer, createControlFrame('pong', { nonce: p.nonce })); return }
    if (frame.type === 'pong') {
      if (peer.nonce !== undefined && p.nonce === peer.nonce) { peer.lastPong = Date.now(); peer.nonce = undefined }
      return
    }
    if (frame.type === 'connect.request') { this.connectRequest(peer, frame.payload as Partial<ConnectRequestPayload>); return }
    const link = typeof p.connectionId === 'string' ? this.links.get(p.connectionId) : undefined
    if (link === undefined || (peer.id !== link.host && peer.id !== link.client)) throw new LinkError('CONNECTION_NOT_FOUND')
    const otherId = peer.id === link.host ? link.client : link.host
    const other = this.peers.get(otherId)
    if (other === undefined) throw new LinkError('CONNECTION_FAILED')
    if (frame.type === 'connect.accepted') {
      if (peer.id !== link.host || link.stage !== 'pending') throw new LinkError('INVALID_MESSAGE')
      link.stage = 'accepted'
      this.send(other, frame)
      return
    }
    if (frame.type === 'connect.rejected') {
      // The computer may end a link at any stage, for example when a pairing fails.
      if (peer.id !== link.host) throw new LinkError('INVALID_MESSAGE')
      this.links.delete(link.id)
      this.send(other, frame)
      return
    }
    if (p.targetDeviceId !== otherId) throw new LinkError('CONNECTION_NOT_FOUND')
    if (frame.type === 'secure.handshake') {
      const { step, data } = frame.payload as Partial<SecureHandshakePayload>
      if (typeof data !== 'string') throw new LinkError('INVALID_MESSAGE')
      if (step === 1 && peer.id === link.client && link.stage === 'accepted') link.stage = 'handshake'
      else if (step === 2 && peer.id === link.host && link.stage === 'handshake') link.stage = 'ready'
      else throw new LinkError('INVALID_MESSAGE')
    } else if (frame.type === 'relay') {
      const { counter, ciphertext } = frame.payload as Partial<RelayPayload>
      if (link.stage !== 'ready' || !Number.isSafeInteger(counter) || typeof ciphertext !== 'string'
        || counter! <= (link.counters.get(peer.id) ?? -1)) {
        throw new LinkError('INVALID_MESSAGE')
      }
      link.counters.set(peer.id, counter!)
    } else {
      throw new LinkError('INVALID_MESSAGE')
    }
    this.send(other, frame)
  }

  private connectRequest(peer: Peer, request: Partial<ConnectRequestPayload>): void {
    if (peer.role !== 'client') throw new LinkError('INVALID_MESSAGE')
    const host = typeof request.hostDeviceId === 'string' ? this.peers.get(request.hostDeviceId) : undefined
    if (host === undefined || host.role !== 'host') {
      this.send(peer, createControlFrame('error', { code: 'HOST_OFFLINE', message: 'The computer is offline.', retryable: true }))
      return
    }
    if (!peer.capabilities.includes(RELAY_CAPABILITY) || !host.capabilities.includes(RELAY_CAPABILITY)) {
      throw new LinkError('CAPABILITY_NOT_SUPPORTED')
    }
    for (const old of this.links.values()) if (old.client === peer.id) this.drop(old, 'CONNECTION_REPLACED')
    if (this.links.size >= (this.options.maxLinks ?? 1024)) throw new LinkError('RATE_LIMITED')
    const link: Link = { id: randomUUID(), host: host.id, client: peer.id, stage: 'pending', created: Date.now(), counters: new Map() }
    this.links.set(link.id, link)
    this.send(host, createControlFrame('connect.incoming', {
      connectionId: link.id,
      clientDeviceId: peer.id,
      clientIdentityKey: this.options.store.get(peer.id)!.identityKey,
    }))
  }
}

/** Phone apps send no Origin; a browser page may only connect from the Server's own origin. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}
