import {
  createRpcRequest,
  decodeMessage,
  encodeMessage,
  type EventPayload,
  type RpcErrorPayload,
  type RpcResponsePayload,
  type TransportStats,
} from './frames.ts'
import type { RemoteTransport } from './transport.ts'

export type RpcClientErrorCode = 'RPC_TIMEOUT' | 'RPC_ABORTED' | 'TRANSPORT_CLOSED' | 'CLIENT_CLOSED'

export class RpcClientError extends Error {
  readonly code: RpcClientErrorCode

  constructor(code: RpcClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = 'RpcClientError'
  }
}

interface PendingCall {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

/**
 * Request and reply over one secure transport. A call is sent once: a timeout
 * or a closed link fails the call and never sends it again.
 */
export class RpcClient {
  private readonly pending = new Map<string, PendingCall>()
  private readonly eventHandlers = new Set<(event: EventPayload) => void>()
  private readonly closeHandlers = new Set<() => void>()
  private unsubscribeTransport?: () => void
  private unsubscribeClose?: () => void
  private closeNotified = false
  private readonly transport: RemoteTransport
  private readonly timeoutMs: number

  constructor(transport: RemoteTransport, timeoutMs = 30_000) {
    this.transport = transport
    this.timeoutMs = timeoutMs
  }

  async connect(): Promise<void> {
    if (this.unsubscribeTransport !== undefined) return
    this.closeNotified = false
    this.unsubscribeTransport = this.transport.onMessage(data => this.handleMessage(data))
    this.unsubscribeClose = this.transport.onClose?.(() => this.handleTransportClose())
    try {
      await this.transport.connect()
    } catch (error) {
      this.unsubscribeTransport()
      this.unsubscribeTransport = undefined
      this.unsubscribeClose?.()
      this.unsubscribeClose = undefined
      throw error
    }
  }

  rpc<TResult = unknown, TParams = unknown>(
    method: string,
    params: TParams,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<TResult> {
    const { signal } = options
    if (signal?.aborted) return Promise.reject(rpcAbortedError(method, signal.reason))
    const timeoutMs = validTimeout(options.timeoutMs) ?? this.timeoutMs
    const request = createRpcRequest(method, params)
    const result = new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(request.id, new RpcClientError('RPC_TIMEOUT', `RPC ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const pending: PendingCall = { method, resolve: resolve as (value: unknown) => void, reject, timer }
      if (signal !== undefined) {
        const onAbort = () => {
          if (this.pending.get(request.id) === pending) this.rejectPending(request.id, rpcAbortedError(method, signal.reason))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        pending.removeAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(request.id, pending)
    })

    // The write is not awaited, so a timeout, abort or close still settles a call whose send stalls.
    try {
      this.transport.send(encodeMessage(request)).catch(error => this.rejectPending(request.id, sendError(error)))
    } catch (error) {
      this.rejectPending(request.id, sendError(error))
    }
    return result
  }

  onEvent(handler: (event: EventPayload) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  getStats(): TransportStats { return this.transport.getStats() }

  async close(): Promise<void> {
    this.unsubscribeTransport?.()
    this.unsubscribeTransport = undefined
    this.unsubscribeClose?.()
    this.unsubscribeClose = undefined
    this.rejectAll(pending => new RpcClientError('CLIENT_CLOSED', `RPC ${pending.method} ended because the client closed`))
    this.notifyClose()
    await this.transport.close()
  }

  private handleTransportClose(): void {
    this.rejectAll(pending => new RpcClientError('TRANSPORT_CLOSED', `RPC ${pending.method} ended because the link closed`))
    this.notifyClose()
  }

  private handleMessage(data: Uint8Array): void {
    const message = decodeMessage(data)
    if (message.type === 'rpc.response') {
      const payload = message.payload as RpcResponsePayload
      this.takePending(payload.requestId)?.resolve(payload.result)
    } else if (message.type === 'rpc.error') {
      const payload = message.payload as RpcErrorPayload
      this.takePending(payload.requestId)?.reject(Object.assign(new Error(payload.message), { code: payload.code }))
    } else if (message.type === 'event') {
      for (const handler of this.eventHandlers) handler(message.payload as EventPayload)
    }
  }

  private takePending(requestId: string): PendingCall | undefined {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return undefined
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.removeAbort?.()
    return pending
  }

  private rejectPending(requestId: string, error: Error): void {
    this.takePending(requestId)?.reject(error)
  }

  private rejectAll(createError: (pending: PendingCall) => Error): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.takePending(requestId)
      if (pending !== undefined) pending.reject(createError(pending))
    }
  }

  private notifyClose(): void {
    if (this.closeNotified) return
    this.closeNotified = true
    for (const handler of this.closeHandlers) handler()
  }
}

function rpcAbortedError(method: string, reason: unknown): RpcClientError {
  return new RpcClientError('RPC_ABORTED', `RPC ${method} was aborted`, reason === undefined ? undefined : { cause: reason })
}

function validTimeout(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : undefined
}

function sendError(error: unknown): Error {
  return error instanceof Error ? error : new Error('link send failed', { cause: error })
}
