import {
  PROTOCOL_VERSION,
  SecureMessageCodec,
  acceptNegotiatedCapabilities,
  createControlFrame,
  createMessage,
  decodeControlFrame,
  decodeMessage,
  encodeControlFrame,
  encodeMessage,
  type ConnectIncomingPayload,
  type ControlFrame,
  type ControlFrameByteLimits,
  type ControlFrameType,
  type HelloAckPayload,
  type HelloPayload,
  type RelayPayload,
  type RemoteMessage,
  type RpcRequestPayload,
  type SecureHandshakePayload,
} from './frames.ts'
import { deviceIdFor, fromBase64Url, toBase64Url } from './keys.ts'
import { NoiseIkSession, createNoisePrologue } from './noise.ts'
import { decodeHandshakeHello, encodeHandshakeHello, type HandshakeHello } from './pairing.ts'
import type { DeviceIdentity } from './secure-transport.ts'
import { waitForRelayCapacity } from './transport.ts'

export interface HostRequest {
  deviceId: string
  signal: AbortSignal
}

export interface HostLinkOptions {
  url: string
  identity: DeviceIdentity
  accessToken: string
  name?: string
  /** Whether a device may start a handshake. */
  admits(deviceId: string, identityKey: string): boolean
  /** The final check, with what the phone sent inside the encrypted handshake. */
  authorize(deviceId: string, identityKey: string, hello: HandshakeHello): boolean | Promise<boolean>
  handle(method: string, params: unknown, request: HostRequest): Promise<unknown>
  createSocket?: (url: string) => WebSocket
  maxTunnels?: number
  retryMs?: readonly [number, number]
  onStatus?: (status: HostLinkStatus) => void
}

export type HostLinkStatus = 'stopped' | 'connecting' | 'online' | 'offline'

interface Tunnel {
  connectionId: string
  deviceId: string
  identityKey: string
  noise: NoiseIkSession
  stage: 'accepted' | 'handshake' | 'ready'
  incoming: SecureMessageCodec
  outgoing: SecureMessageCodec
  counter: number
  lastCounter: number
  sendTail: Promise<void>
  calls: Map<string, AbortController>
  // Unsettled emit() sends; a phone too far behind gets dropped and reconnects.
  emitPending?: number
}

const RELAY_CAPABILITY = 'transport.relay'
const MAX_CALLS_PER_TUNNEL = 32
const MAX_EMIT_PENDING = 64
const SERVER_SILENCE_MS = 75_000

class TunnelError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * The computer's side of the link: it keeps one control connection to the Server,
 * answers phones as the Noise responder, and runs their calls. It sends a reply once
 * and never repeats a call.
 */
export class HostLink {
  private readonly options: HostLinkOptions
  private readonly tunnels = new Map<string, Tunnel>()
  private socket?: WebSocket
  private limits: ControlFrameByteLimits = {}
  private running = false
  private loopDone?: Promise<void>
  private wake?: () => void
  private currentStatus: HostLinkStatus = 'stopped'
  private readonly statusWaiters = new Set<() => void>()

  constructor(options: HostLinkOptions) {
    if (deviceIdFor(options.identity.publicKey) !== options.identity.deviceId) {
      throw new Error('The computer\'s device id does not match its identity key.')
    }
    this.options = options
  }

  get status(): HostLinkStatus { return this.currentStatus }

  start(): void {
    if (this.running) return
    this.running = true
    this.loopDone = this.loop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.wake?.()
    this.socket?.close()
    await this.loopDone
    this.loopDone = undefined
  }

  async waitOnline(timeoutMs = 10_000): Promise<void> {
    const started = Date.now()
    while (this.currentStatus !== 'online') {
      const left = timeoutMs - (Date.now() - started)
      if (left <= 0) throw new Error('The computer did not reach the Server in time.')
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, left)
        function done(): void { clearTimeout(timer); resolve() }
        this.statusWaiters.add(done)
      })
    }
  }

  /** Phones with a finished handshake. */
  connectedDevices(): string[] {
    return [...this.tunnels.values()].filter(tunnel => tunnel.stage === 'ready').map(tunnel => tunnel.deviceId)
  }

  /** Ends every link of a device, for example when the user removes it. */
  disconnect(deviceId: string): void {
    for (const tunnel of [...this.tunnels.values()]) if (tunnel.deviceId === deviceId) this.dropTunnel(tunnel, 'DEVICE_REVOKED')
  }

  /** Tells every connected phone that something changed. */
  emit(event: string, data: unknown): void {
    const message = encodeMessage(createMessage('event', { event, data }))
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.stage !== 'ready') continue
      if ((tunnel.emitPending ?? 0) >= MAX_EMIT_PENDING) {
        this.dropTunnel(tunnel, 'SEND_FAILED')
        continue
      }
      tunnel.emitPending = (tunnel.emitPending ?? 0) + 1
      void this.sendSecure(tunnel, message)
        .catch(() => this.dropTunnel(tunnel, 'SEND_FAILED'))
        .finally(() => { if (tunnel.emitPending !== undefined) tunnel.emitPending -= 1 })
    }
  }

  private setStatus(status: HostLinkStatus): void {
    if (status === this.currentStatus) return
    this.currentStatus = status
    for (const waiter of [...this.statusWaiters]) waiter()
    this.statusWaiters.clear()
    this.options.onStatus?.(status)
  }

  private async loop(): Promise<void> {
    const [min, max] = this.options.retryMs ?? [1_000, 60_000]
    let delay = min
    while (this.running) {
      this.setStatus('connecting')
      const reachedServer = await this.connectOnce().catch(() => false)
      this.dropAll()
      if (!this.running) break
      this.setStatus('offline')
      if (reachedServer) delay = min
      await new Promise<void>(resolve => {
        const done = (): void => {
          clearTimeout(timer)
          if (this.wake === done) this.wake = undefined
          resolve()
        }
        const timer = setTimeout(done, delay * (0.8 + Math.random() * 0.4))
        this.wake = done
      })
      delay = Math.min(delay * 2, max)
    }
    this.setStatus('stopped')
  }

  /** One control connection; resolves when it closes, with whether the Server accepted us. */
  private connectOnce(): Promise<boolean> {
    return new Promise(resolve => {
      let accepted = false
      let lastHeard = Date.now()
      const socket = this.options.createSocket?.(this.options.url) ?? new WebSocket(this.options.url)
      this.socket = socket
      this.limits = {}
      const watchdog = setInterval(() => {
        if (Date.now() - lastHeard > SERVER_SILENCE_MS) socket.close()
      }, 15_000)
      socket.onopen = () => {
        this.sendControl('hello', {
          role: 'host',
          deviceId: this.options.identity.deviceId,
          identityKey: this.options.identity.publicKey,
          accessToken: this.options.accessToken,
          protocols: [PROTOCOL_VERSION],
          capabilities: [RELAY_CAPABILITY],
        } satisfies HelloPayload)
      }
      socket.onmessage = event => {
        lastHeard = Date.now()
        try {
          if (typeof event.data !== 'string') throw new Error('Control frames must be text.')
          const frame = decodeControlFrame(event.data, this.limits)
          if (frame.type === 'hello.ack') {
            this.acceptHello(frame.payload as Partial<HelloAckPayload>)
            accepted = true
            this.setStatus('online')
            return
          }
          if (!accepted) throw new Error('The Server did not answer hello first.')
          this.handleFrame(frame)
        } catch {
          socket.close()
        }
      }
      socket.onerror = () => socket.close()
      socket.onclose = () => {
        clearInterval(watchdog)
        if (this.socket === socket) this.socket = undefined
        resolve(accepted)
      }
    })
  }

  private acceptHello(payload: Partial<HelloAckPayload>): void {
    if (payload.protocol !== PROTOCOL_VERSION) throw new Error('The Server chose an unsupported protocol.')
    if (!acceptNegotiatedCapabilities([RELAY_CAPABILITY], payload.capabilities).includes(RELAY_CAPABILITY)) {
      throw new Error('The Server does not relay.')
    }
    this.limits = { maxControlFrameBytes: payload.maxControlFrameBytes, maxRelayFrameBytes: payload.maxRelayFrameBytes }
  }

  private handleFrame(frame: ControlFrame): void {
    const payload = frame.payload as Record<string, unknown>
    if (frame.type === 'ping') { this.sendControl('pong', payload); return }
    if (frame.type === 'connect.incoming') { this.incoming(payload as Partial<ConnectIncomingPayload>); return }
    if (frame.type === 'error') {
      const tunnel = typeof payload.connectionId === 'string' ? this.tunnels.get(payload.connectionId) : undefined
      if (tunnel !== undefined) this.dropTunnel(tunnel, undefined)
      return
    }
    if (frame.type !== 'secure.handshake' && frame.type !== 'relay') return
    const tunnel = typeof payload.connectionId === 'string' ? this.tunnels.get(payload.connectionId) : undefined
    if (tunnel === undefined) return
    try {
      if (payload.targetDeviceId !== this.options.identity.deviceId) throw new TunnelError('INVALID_MESSAGE', 'Frame for another device.')
      if (frame.type === 'secure.handshake') void this.handshake(tunnel, payload as Partial<SecureHandshakePayload>)
      else this.relay(tunnel, payload as Partial<RelayPayload>)
    } catch (error) {
      this.dropTunnel(tunnel, error instanceof TunnelError ? error.code : 'INVALID_MESSAGE')
    }
  }

  private incoming(payload: Partial<ConnectIncomingPayload>): void {
    const { connectionId, clientDeviceId, clientIdentityKey } = payload
    if (typeof connectionId !== 'string' || connectionId.length === 0) return
    const reject = (code: string) => this.sendControl('connect.rejected', { connectionId, code, message: code })
    let validKey = false
    try { validKey = typeof clientIdentityKey === 'string' && deviceIdFor(clientIdentityKey) === clientDeviceId } catch {}
    if (!validKey || this.tunnels.has(connectionId)) { reject('INVALID_MESSAGE'); return }
    if (this.tunnels.size >= (this.options.maxTunnels ?? 16)) { reject('HOST_BUSY'); return }
    if (!this.options.admits(clientDeviceId!, clientIdentityKey!)) { reject('NOT_PAIRED'); return }
    const { identity } = this.options
    this.tunnels.set(connectionId, {
      connectionId,
      deviceId: clientDeviceId!,
      identityKey: clientIdentityKey!,
      noise: new NoiseIkSession({
        role: 'responder',
        localPrivateKey: identity.privateKey,
        localPublicKey: identity.publicKey,
        remotePublicKey: clientIdentityKey!,
        prologue: createNoisePrologue(connectionId, identity.deviceId, clientDeviceId!),
      }),
      stage: 'accepted',
      incoming: new SecureMessageCodec(),
      outgoing: new SecureMessageCodec(),
      counter: 0,
      lastCounter: -1,
      sendTail: Promise.resolve(),
      calls: new Map(),
    })
    this.sendControl('connect.accepted', { connectionId })
  }

  private async handshake(tunnel: Tunnel, payload: Partial<SecureHandshakePayload>): Promise<void> {
    try {
      if (payload.step !== 1 || tunnel.stage !== 'accepted' || typeof payload.data !== 'string') {
        throw new TunnelError('INVALID_MESSAGE', 'Handshake out of order.')
      }
      tunnel.stage = 'handshake'
      const hello = decodeHandshakeHello(tunnel.noise.readHandshake(fromBase64Url(payload.data)))
      const allowed = await this.options.authorize(tunnel.deviceId, tunnel.identityKey, hello)
      if (this.tunnels.get(tunnel.connectionId) !== tunnel) return
      if (!allowed) throw new TunnelError('NOT_PAIRED', 'The phone is not paired.')
      const reply = tunnel.noise.writeHandshake(encodeHandshakeHello(this.options.name === undefined ? {} : { name: this.options.name }))
      tunnel.stage = 'ready'
      this.sendControl('secure.handshake', {
        connectionId: tunnel.connectionId,
        targetDeviceId: tunnel.deviceId,
        step: 2,
        data: toBase64Url(reply),
      } satisfies SecureHandshakePayload)
    } catch (error) {
      this.dropTunnel(tunnel, error instanceof TunnelError ? error.code : 'HANDSHAKE_FAILED')
    }
  }

  private relay(tunnel: Tunnel, payload: Partial<RelayPayload>): void {
    if (tunnel.stage !== 'ready' || !Number.isSafeInteger(payload.counter) || payload.counter! <= tunnel.lastCounter
      || typeof payload.ciphertext !== 'string') {
      throw new TunnelError('INVALID_MESSAGE', 'Relay frame out of order.')
    }
    tunnel.lastCounter = payload.counter!
    const plain = tunnel.incoming.decode(tunnel.noise.decrypt(fromBase64Url(payload.ciphertext)))
    if (plain === undefined) return
    void this.serve(tunnel, decodeMessage(plain))
  }

  private async serve(tunnel: Tunnel, message: RemoteMessage): Promise<void> {
    if (message.type !== 'rpc.request' || tunnel.calls.has(message.id)) return
    const { method, params } = message.payload as Partial<RpcRequestPayload>
    const requestId = message.id
    let reply: RemoteMessage
    if (typeof method !== 'string' || method.length === 0) {
      reply = createMessage('rpc.error', { requestId, code: 'INVALID_REQUEST', message: 'The call has no method.' })
    } else if (tunnel.calls.size >= MAX_CALLS_PER_TUNNEL) {
      reply = createMessage('rpc.error', { requestId, code: 'RATE_LIMITED', message: 'Too many calls at once.', retryable: true })
    } else {
      const controller = new AbortController()
      tunnel.calls.set(requestId, controller)
      try {
        const result = await this.options.handle(method, params, { deviceId: tunnel.deviceId, signal: controller.signal })
        reply = createMessage('rpc.response', { requestId, result: result ?? null })
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'HOST_ERROR'
        reply = createMessage('rpc.error', { requestId, code, message: error instanceof Error ? error.message : String(error) })
      } finally {
        tunnel.calls.delete(requestId)
      }
      if (controller.signal.aborted) return
    }
    if (this.tunnels.get(tunnel.connectionId) !== tunnel) return
    await this.sendSecure(tunnel, encodeMessage(reply)).catch(() => this.dropTunnel(tunnel, 'SEND_FAILED'))
  }

  /** Noise counters are not re-entrant, so each tunnel sends one message at a time. */
  private sendSecure(tunnel: Tunnel, data: Uint8Array): Promise<void> {
    const run = tunnel.sendTail.then(async () => {
      for (const plaintext of tunnel.outgoing.encode(data)) {
        if (this.tunnels.get(tunnel.connectionId) !== tunnel || this.socket === undefined) throw new Error('The tunnel closed.')
        const ciphertext = tunnel.noise.encrypt(plaintext)
        await waitForRelayCapacity(this.socket)
        this.sendControl('relay', {
          connectionId: tunnel.connectionId,
          targetDeviceId: tunnel.deviceId,
          counter: tunnel.counter,
          ciphertext: toBase64Url(ciphertext),
        } satisfies RelayPayload)
        tunnel.counter += 1
      }
    })
    tunnel.sendTail = run.catch(() => undefined)
    return run
  }

  private dropTunnel(tunnel: Tunnel, code: string | undefined): void {
    if (this.tunnels.get(tunnel.connectionId) !== tunnel) return
    this.tunnels.delete(tunnel.connectionId)
    for (const controller of tunnel.calls.values()) controller.abort(new Error('The phone link closed.'))
    tunnel.calls.clear()
    tunnel.noise.destroy()
    tunnel.incoming.reset()
    tunnel.outgoing.reset()
    if (code !== undefined) {
      try { this.sendControl('connect.rejected', { connectionId: tunnel.connectionId, code, message: code }) } catch {}
    }
  }

  private dropAll(): void {
    for (const tunnel of [...this.tunnels.values()]) this.dropTunnel(tunnel, undefined)
  }

  private sendControl(type: ControlFrameType, payload: unknown): void {
    if (this.socket?.readyState !== 1) throw new Error('The Server connection is not open.')
    this.socket.send(encodeControlFrame(createControlFrame(type, payload), this.limits))
  }
}
