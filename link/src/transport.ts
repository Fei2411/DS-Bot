import { MAX_RELAY_FRAME_BYTES, MAX_RELAY_BYTES_PER_SECOND, MAX_RELAY_FRAMES_PER_SECOND, type TransportStats } from './frames.ts'

export interface RemoteTransport {
  connect(): Promise<void>
  send(data: Uint8Array): Promise<void>
  onMessage(cb: (data: Uint8Array) => void): () => void
  onClose?(cb: () => void): () => void
  /** Ask the far end for a liveness reply now, when the transport supports it. */
  probe?(): void
  close(): Promise<void>
  getStats(): TransportStats
}

export interface SecureHandshakeTransport extends RemoteTransport {
  connectionInfo(): { connectionId: string; localDeviceId: string; remoteDeviceId: string }
  sendHandshake(step: number, data: Uint8Array): Promise<void>
  onHandshake(cb: (step: number, data: Uint8Array) => void): () => void
  readonly closeReason?: Error
}

type MessageHandler = (data: Uint8Array) => void

export abstract class BaseTransport implements RemoteTransport {
  protected handlers = new Set<MessageHandler>()
  protected closeHandlers = new Set<() => void>()

  onMessage(cb: MessageHandler): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }

  onClose(cb: () => void): () => void {
    this.closeHandlers.add(cb)
    return () => this.closeHandlers.delete(cb)
  }

  protected emit(data: Uint8Array): void {
    for (const handler of this.handlers) handler(data)
  }

  protected emitClose(): void {
    for (const handler of this.closeHandlers) handler()
  }

  abstract connect(): Promise<void>
  abstract send(data: Uint8Array): Promise<void>
  abstract close(): Promise<void>
  abstract getStats(): TransportStats
}

const nextSends = new WeakMap<object, number>()

/** Bounds Relay buffering without changing frame order. Call from serialized sends. */
export async function waitForRelayCapacity(socket: { readonly readyState: number; readonly bufferedAmount?: number }, wireBytes = 0): Promise<void> {
  const started = Date.now()
  while ((socket.bufferedAmount ?? 0) > 512 * 1024) {
    if (socket.readyState !== 1 || Date.now() - started > 10_000) throw new Error('Relay consumer is too slow or disconnected')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  if (wireBytes > 0) {
    // Pace encoded envelopes across all tunnels on a socket. A full frame of
    // headroom covers control traffic and avoids turning a one-second burst
    // allowance into repeated bursts at the boundary of the Server's window.
    const now = Date.now()
    const due = Math.max(now, nextSends.get(socket) ?? now)
    const interval = Math.max(1000 / (MAX_RELAY_FRAMES_PER_SECOND - 1), 1000 * wireBytes / (MAX_RELAY_BYTES_PER_SECOND - MAX_RELAY_FRAME_BYTES))
    nextSends.set(socket, due + interval)
    if (due > now) await new Promise<void>(resolve => setTimeout(resolve, Math.ceil(due - now)))
  }
  if (socket.readyState !== 1) throw new Error('Relay transport closed')
}
