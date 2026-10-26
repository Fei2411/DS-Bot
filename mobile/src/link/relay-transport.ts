import {
  PROTOCOL_VERSION,
  acceptNegotiatedCapabilities,
  createControlFrame,
  decodeControlFrame,
  encodeControlFrame,
  type ConnectAcceptedPayload,
  type ConnectRequestPayload,
  type ControlFrameByteLimits,
  type ControlFrameType,
  type HelloAckPayload,
  type HelloPayload,
  type RelayPayload,
  type SecureHandshakePayload,
  type TransportStats,
} from './frames.ts'
import { fromBase64Url, toBase64Url } from './keys.ts'
import { BaseTransport, type SecureHandshakeTransport, waitForRelayCapacity } from './transport.ts'

export interface RelayTransportOptions {
  deviceId: string
  accessToken: string
  targetDeviceId: string
  capabilities?: string[]
  handshakeTimeoutMs?: number
  createSocket?: (url: string) => WebSocket
}

const RELAY_CAPABILITY = 'transport.relay'

/** Client side of the Server's Relay: the Server only forwards ciphertext. */
export class RelayTransport extends BaseTransport implements SecureHandshakeTransport {
  private readonly handshakeHandlers = new Set<(step: number, data: Uint8Array) => void>()
  private socket?: WebSocket
  private bytesSent = 0
  private bytesReceived = 0
  private connectionId?: string
  private relayCounter = 0
  private readyResolve?: () => void
  private readyReject?: (error: Error) => void
  private handshakeTimer?: ReturnType<typeof setTimeout>
  private controlFrameLimits: ControlFrameByteLimits = {}
  private readonly url: string
  private readonly options: RelayTransportOptions

  constructor(url: string, options: RelayTransportOptions) {
    super()
    this.url = url
    this.options = options
  }

  async connect(): Promise<void> {
    if (this.socket !== undefined) return
    this.socket = this.options.createSocket?.(this.url) ?? new WebSocket(this.url)
    this.controlFrameLimits = {}
    this.relayCounter = 0
    this.socket.binaryType = 'arraybuffer'
    await new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.handshakeTimer = setTimeout(
        () => this.failConnection(new Error('Relay control handshake timed out')),
        this.options.handshakeTimeoutMs ?? 10_000,
      )
      const socket = this.socket!
      socket.onmessage = event => this.handleSocketMessage(event.data)
      socket.onopen = () => {
        this.sendControl('hello', {
          role: 'client',
          deviceId: this.options.deviceId,
          accessToken: this.options.accessToken,
          protocols: [PROTOCOL_VERSION],
          capabilities: this.offeredCapabilities(),
        } satisfies HelloPayload)
      }
      socket.onerror = () => this.failConnection(new Error(`RelayTransport failed to connect to ${this.url}`))
      socket.onclose = () => {
        if (this.readyReject !== undefined) this.failConnection(new Error('Relay control channel closed before it was ready'))
        this.socket = undefined
        this.connectionId = undefined
        this.emitClose()
      }
    })
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.socket?.readyState !== 1) throw new Error('relay transport is not connected')
    if (this.connectionId === undefined) throw new Error('relay connection has not been authorized')
    await waitForRelayCapacity(this.socket)
    this.sendControl('relay', {
      connectionId: this.connectionId,
      targetDeviceId: this.options.targetDeviceId,
      counter: this.relayCounter,
      ciphertext: toBase64Url(data),
    } satisfies RelayPayload)
    this.bytesSent += data.byteLength
    this.relayCounter += 1
  }

  connectionInfo(): { connectionId: string; localDeviceId: string; remoteDeviceId: string } {
    if (this.connectionId === undefined) throw new Error('relay connection has not been authorized')
    return {
      connectionId: this.connectionId,
      localDeviceId: this.options.deviceId,
      remoteDeviceId: this.options.targetDeviceId,
    }
  }

  async sendHandshake(step: number, data: Uint8Array): Promise<void> {
    if (this.socket?.readyState !== 1 || this.connectionId === undefined) {
      throw new Error('relay connection has not been authorized')
    }
    this.sendControl('secure.handshake', {
      connectionId: this.connectionId,
      targetDeviceId: this.options.targetDeviceId,
      step,
      data: toBase64Url(data),
    } satisfies SecureHandshakePayload)
  }

  onHandshake(cb: (step: number, data: Uint8Array) => void): () => void {
    this.handshakeHandlers.add(cb)
    return () => this.handshakeHandlers.delete(cb)
  }

  async close(): Promise<void> {
    this.clearHandshake()
    this.socket?.close()
    this.socket = undefined
    this.connectionId = undefined
  }

  getStats(): TransportStats {
    const connected = this.socket?.readyState === 1
    return { mode: connected ? 'Relay' : 'Disconnected', connected, bytesSent: this.bytesSent, bytesReceived: this.bytesReceived }
  }

  private offeredCapabilities(): string[] {
    return this.options.capabilities ?? [RELAY_CAPABILITY]
  }

  private handleSocketMessage(raw: unknown): void {
    try {
      if (typeof raw !== 'string') throw new Error('Relay control frames must be text JSON')
      const frame = decodeControlFrame(raw, this.controlFrameLimits)
      if (frame.type === 'hello.ack') {
        const payload = frame.payload as Partial<HelloAckPayload>
        if (payload.protocol !== PROTOCOL_VERSION) throw new Error('Server selected an unsupported protocol version')
        const negotiated = acceptNegotiatedCapabilities(this.offeredCapabilities(), payload.capabilities)
        this.controlFrameLimits = {
          maxControlFrameBytes: payload.maxControlFrameBytes,
          maxRelayFrameBytes: payload.maxRelayFrameBytes,
        }
        if (!negotiated.includes(RELAY_CAPABILITY)) throw new Error('Server did not negotiate the required Relay capability')
        this.sendControl('connect.request', { hostDeviceId: this.options.targetDeviceId } satisfies ConnectRequestPayload)
        return
      }
      if (frame.type === 'connect.accepted') {
        const payload = frame.payload as Partial<ConnectAcceptedPayload>
        if (typeof payload.connectionId !== 'string' || payload.connectionId.length === 0) {
          throw new Error('connect.accepted did not include a connectionId')
        }
        this.connectionId = payload.connectionId
        this.finishConnection()
        return
      }
      if (frame.type === 'connect.rejected' || frame.type === 'error') {
        const payload = frame.payload as { message?: unknown; code?: unknown }
        const message = typeof payload.message === 'string' ? payload.message : 'Server rejected the relay connection'
        throw Object.assign(new Error(message), { code: payload.code })
      }
      if (frame.type === 'relay') {
        const payload = frame.payload as Partial<RelayPayload>
        if (payload.connectionId !== this.connectionId
          || payload.targetDeviceId !== this.options.deviceId
          || !Number.isSafeInteger(payload.counter)
          || typeof payload.ciphertext !== 'string') {
          throw new Error('Received a relay frame for an unknown connection')
        }
        const data = fromBase64Url(payload.ciphertext)
        this.bytesReceived += data.byteLength
        this.emit(data)
        return
      }
      if (frame.type === 'secure.handshake') {
        const payload = frame.payload as Partial<SecureHandshakePayload>
        if (payload.connectionId !== this.connectionId
          || payload.targetDeviceId !== this.options.deviceId
          || !Number.isSafeInteger(payload.step)
          || typeof payload.data !== 'string') {
          throw new Error('Received a secure handshake frame for an unknown connection')
        }
        const data = fromBase64Url(payload.data)
        for (const handler of this.handshakeHandlers) handler(payload.step!, data)
        return
      }
      if (frame.type === 'ping') this.sendControl('pong', frame.payload)
    } catch (error) {
      this.failConnection(error instanceof Error ? error : new Error('Invalid relay control frame'))
    }
  }

  private sendControl(type: ControlFrameType, payload: unknown): void {
    if (this.socket?.readyState !== 1) throw new Error('relay control socket is not open')
    this.socket.send(encodeControlFrame(createControlFrame(type, payload), this.controlFrameLimits))
  }

  private finishConnection(): void {
    this.clearHandshake()
    this.readyResolve?.()
    this.readyResolve = undefined
    this.readyReject = undefined
  }

  private failConnection(error: Error): void {
    this.clearHandshake()
    const reject = this.readyReject
    this.readyResolve = undefined
    this.readyReject = undefined
    reject?.(error)
    this.socket?.close()
    this.socket = undefined
    this.connectionId = undefined
  }

  private clearHandshake(): void {
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
  }
}
