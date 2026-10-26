export const PROTOCOL_VERSION = 1
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024
export const MAX_RELAY_FRAME_BYTES = 1024 * 1024
export const SECURE_FRAGMENT_CHUNK_BYTES = 48 * 1024
export const MAX_SECURE_MESSAGE_BYTES = 4 * 1024 * 1024

const SECURE_FRAGMENT_MAGIC = new Uint8Array([0x44, 0x53, 0x42, 0x46]) // DSBF
const SECURE_FRAGMENT_VERSION = 1
const SECURE_FRAGMENT_HEADER_BYTES = 17
const MAX_IN_FLIGHT_SECURE_MESSAGES = 8

export const controlFrameTypes = [
  'hello',
  'hello.ack',
  'connect.request',
  'connect.incoming',
  'connect.accepted',
  'connect.rejected',
  'secure.handshake',
  'relay',
  'ping',
  'pong',
  'error',
] as const
export type ControlFrameType = typeof controlFrameTypes[number]

export const messageTypes = ['rpc.request', 'rpc.response', 'rpc.error', 'event'] as const
export type MessageType = typeof messageTypes[number]

export interface ControlFrame<TPayload = unknown> {
  v: typeof PROTOCOL_VERSION
  id: string
  type: ControlFrameType
  timestamp: number
  payload: TPayload
}

export interface ControlFrameByteLimits {
  maxControlFrameBytes?: number
  maxRelayFrameBytes?: number
}

export interface HelloPayload {
  role: 'host' | 'client'
  deviceId: string
  accessToken: string
  protocols: number[]
  capabilities: string[]
  clientVersion?: string
}

export interface HelloAckPayload {
  protocol: typeof PROTOCOL_VERSION
  serverVersion: string
  connectionSessionId: string
  heartbeatIntervalMs: number
  maxControlFrameBytes: number
  maxRelayFrameBytes: number
  capabilities?: string[]
}

export interface ConnectRequestPayload {
  hostDeviceId: string
}

export interface ConnectIncomingPayload {
  connectionId: string
  clientDeviceId: string
  clientIdentityKey: string
}

export interface ConnectAcceptedPayload {
  connectionId: string
}

export interface ConnectRejectedPayload {
  connectionId: string
  code?: string
  message?: string
}

export interface SecureHandshakePayload {
  connectionId: string
  targetDeviceId: string
  step: number
  data: string
}

export interface RelayPayload {
  connectionId: string
  targetDeviceId: string
  counter: number
  ciphertext: string
}

export interface ControlErrorPayload {
  code: string
  message: string
  retryable?: boolean
  connectionId?: string
}

export interface RemoteMessage<TPayload = unknown> {
  v: typeof PROTOCOL_VERSION
  id: string
  type: MessageType
  timestamp: number
  payload: TPayload
}

export interface RpcRequestPayload<TParams = unknown> {
  method: string
  params: TParams
}

export interface RpcResponsePayload<TResult = unknown> {
  requestId: string
  result: TResult
}

export interface RpcErrorPayload {
  requestId: string
  code: string
  message: string
  details?: unknown
  retryable?: boolean
}

export interface EventPayload<TData = unknown> {
  event: string
  data: TData
  seq?: number
}

export interface TransportStats {
  mode: 'Relay' | 'Disconnected'
  connected: boolean
  bytesSent: number
  bytesReceived: number
}

/** Keeps only the capabilities both sides offered, in the order this side offered them. */
export function acceptNegotiatedCapabilities(offered: readonly string[], selected: unknown): string[] {
  if (!Array.isArray(selected) || !selected.every(item => typeof item === 'string')) return []
  const chosen = new Set(selected)
  return offered.filter(item => chosen.has(item))
}

export function createControlFrame<TPayload>(type: ControlFrameType, payload: TPayload, id = randomId()): ControlFrame<TPayload> {
  return { v: PROTOCOL_VERSION, id, type, timestamp: Date.now(), payload }
}

export function createMessage<TPayload>(type: MessageType, payload: TPayload, id = randomId()): RemoteMessage<TPayload> {
  return { v: PROTOCOL_VERSION, id, type, timestamp: Date.now(), payload }
}

export function createRpcRequest<TParams>(method: string, params: TParams, id?: string): RemoteMessage<RpcRequestPayload<TParams>> {
  return createMessage('rpc.request', { method, params }, id)
}

export function encodeControlFrame(frame: ControlFrame, limits: ControlFrameByteLimits = {}): string {
  const encoded = JSON.stringify(parseControlFrame(frame))
  assertControlFrameSize(new TextEncoder().encode(encoded).byteLength, frame.type, limits)
  return encoded
}

export function decodeControlFrame(data: Uint8Array | string, limits: ControlFrameByteLimits = {}): ControlFrame {
  const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data
  if (encoded.byteLength > MAX_RELAY_FRAME_BYTES) throw new Error('Control frame exceeds the Relay frame limit.')
  const text = typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: true }).decode(data)
  const frame = parseControlFrame(JSON.parse(text))
  assertControlFrameSize(encoded.byteLength, frame.type, limits)
  return frame
}

export function encodeMessage(message: RemoteMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message))
}

export function decodeMessage(data: Uint8Array | string): RemoteMessage {
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
  const value: unknown = JSON.parse(text)
  if (!isEnvelope(value) || !(messageTypes as readonly string[]).includes(value.type)) {
    throw new Error('Remote message is invalid.')
  }
  return value as RemoteMessage
}

function parseControlFrame(value: unknown): ControlFrame {
  if (!isEnvelope(value) || !(controlFrameTypes as readonly string[]).includes(value.type)) {
    throw new Error('Control frame is invalid.')
  }
  return value as ControlFrame
}

function isEnvelope(value: unknown): value is { v: number; id: string; type: string; timestamp: number; payload: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Record<string, unknown>
  return frame.v === PROTOCOL_VERSION
    && typeof frame.id === 'string' && frame.id.length > 0
    && typeof frame.type === 'string'
    && typeof frame.timestamp === 'number'
    && typeof frame.payload === 'object' && frame.payload !== null
}

interface FragmentAssembly {
  total: number
  totalBytes: number
  receivedBytes: number
  chunks: Uint8Array[]
}

/**
 * Splits plaintext before Noise encryption and joins it after decryption.
 * One Noise transport message holds at most 65,535 bytes.
 */
export class SecureMessageCodec {
  private nextMessageId = 1
  private readonly assemblies = new Map<number, FragmentAssembly>()

  encode(message: Uint8Array): Uint8Array[] {
    if (message.byteLength > MAX_SECURE_MESSAGE_BYTES) throw new Error('Secure message exceeds the reassembly limit.')
    if (message.byteLength <= SECURE_FRAGMENT_CHUNK_BYTES) return [message]

    const messageId = this.nextMessageId
    this.nextMessageId = messageId === 0xffff_ffff ? 1 : messageId + 1
    const total = Math.ceil(message.byteLength / SECURE_FRAGMENT_CHUNK_BYTES)
    const frames: Uint8Array[] = []
    for (let index = 0; index < total; index += 1) {
      const start = index * SECURE_FRAGMENT_CHUNK_BYTES
      const chunk = message.subarray(start, Math.min(message.byteLength, start + SECURE_FRAGMENT_CHUNK_BYTES))
      const frame = new Uint8Array(SECURE_FRAGMENT_HEADER_BYTES + chunk.byteLength)
      frame.set(SECURE_FRAGMENT_MAGIC)
      frame[4] = SECURE_FRAGMENT_VERSION
      const view = new DataView(frame.buffer)
      view.setUint32(5, messageId)
      view.setUint16(9, index)
      view.setUint16(11, total)
      view.setUint32(13, message.byteLength)
      frame.set(chunk, SECURE_FRAGMENT_HEADER_BYTES)
      frames.push(frame)
    }
    return frames
  }

  decode(frame: Uint8Array): Uint8Array | undefined {
    if (!isSecureFragment(frame)) return frame
    if (frame.byteLength < SECURE_FRAGMENT_HEADER_BYTES || frame[4] !== SECURE_FRAGMENT_VERSION) {
      throw new Error('Secure fragment header is invalid.')
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const messageId = view.getUint32(5)
    const index = view.getUint16(9)
    const total = view.getUint16(11)
    const totalBytes = view.getUint32(13)
    if (messageId === 0 || total < 2 || index >= total || totalBytes <= SECURE_FRAGMENT_CHUNK_BYTES
      || totalBytes > MAX_SECURE_MESSAGE_BYTES
      || total !== Math.ceil(totalBytes / SECURE_FRAGMENT_CHUNK_BYTES)) {
      throw new Error('Secure fragment metadata is invalid.')
    }
    const expectedChunkBytes = Math.min(SECURE_FRAGMENT_CHUNK_BYTES, totalBytes - index * SECURE_FRAGMENT_CHUNK_BYTES)
    const chunk = frame.subarray(SECURE_FRAGMENT_HEADER_BYTES)
    if (chunk.byteLength !== expectedChunkBytes) throw new Error('Secure fragment length is invalid.')

    let assembly = this.assemblies.get(messageId)
    if (assembly === undefined) {
      if (index !== 0 || this.assemblies.size >= MAX_IN_FLIGHT_SECURE_MESSAGES) {
        throw new Error('Secure fragment sequence is invalid.')
      }
      assembly = { total, totalBytes, receivedBytes: 0, chunks: [] }
      this.assemblies.set(messageId, assembly)
    }
    if (assembly.total !== total || assembly.totalBytes !== totalBytes || index !== assembly.chunks.length) {
      this.assemblies.delete(messageId)
      throw new Error('Secure fragment sequence is invalid.')
    }
    assembly.chunks.push(Uint8Array.from(chunk))
    assembly.receivedBytes += chunk.byteLength
    if (assembly.chunks.length < total) return undefined
    this.assemblies.delete(messageId)
    if (assembly.receivedBytes !== totalBytes) throw new Error('Secure message length is invalid.')
    const message = new Uint8Array(totalBytes)
    let offset = 0
    for (const part of assembly.chunks) {
      message.set(part, offset)
      offset += part.byteLength
    }
    return message
  }

  reset(): void {
    this.nextMessageId = 1
    this.assemblies.clear()
  }
}

function isSecureFragment(frame: Uint8Array): boolean {
  if (frame.byteLength < SECURE_FRAGMENT_MAGIC.byteLength) return false
  for (let index = 0; index < SECURE_FRAGMENT_MAGIC.byteLength; index += 1) {
    if (frame[index] !== SECURE_FRAGMENT_MAGIC[index]) return false
  }
  return true
}

function assertControlFrameSize(bytes: number, type: ControlFrameType, limits: ControlFrameByteLimits): void {
  const configured = type === 'relay' ? limits.maxRelayFrameBytes : limits.maxControlFrameBytes
  const protocolMaximum = type === 'relay' ? MAX_RELAY_FRAME_BYTES : MAX_CONTROL_FRAME_BYTES
  const maximum = configured === undefined ? protocolMaximum : Math.min(protocolMaximum, configured)
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('Control frame limit is invalid.')
  if (bytes > maximum) throw new Error(`${type === 'relay' ? 'Relay' : 'Control'} frame exceeds its limit.`)
}

function randomId(): string {
  return globalThis.crypto.randomUUID()
}
