import { SecureMessageCodec, type TransportStats } from './frames.ts'
import { NoiseIkSession, createNoisePrologue } from './noise.ts'
import type { RemoteTransport, SecureHandshakeTransport } from './transport.ts'

export interface DeviceIdentity {
  deviceId: string
  publicKey: string
  privateKey: string
}

export interface PairedHost {
  deviceId: string
  identityKey: string
}

/** End-to-end Noise channel from this phone to one paired computer, over any carrier. */
export class SecureTransport implements RemoteTransport {
  private noise?: NoiseIkSession
  private unsubscribeInner?: () => void
  private readonly incoming = new SecureMessageCodec()
  private readonly outgoing = new SecureMessageCodec()
  private closed = false
  private sendTail: Promise<void> = Promise.resolve()
  private readonly inner: SecureHandshakeTransport
  private readonly identity: DeviceIdentity
  private readonly host: PairedHost
  private readonly handshakeTimeoutMs: number

  constructor(inner: SecureHandshakeTransport, identity: DeviceIdentity, host: PairedHost, handshakeTimeoutMs = 10_000) {
    this.inner = inner
    this.identity = identity
    this.host = host
    this.handshakeTimeoutMs = handshakeTimeoutMs
    if (host.identityKey.length === 0) throw new Error('The paired computer has no identity key.')
  }

  async connect(): Promise<void> {
    this.closed = false
    this.incoming.reset()
    this.outgoing.reset()
    await this.inner.connect()
    const info = this.inner.connectionInfo()
    if (info.localDeviceId !== this.identity.deviceId || info.remoteDeviceId !== this.host.deviceId) {
      await this.inner.close()
      throw new Error('The Server connected this phone to a different device.')
    }
    const noise = new NoiseIkSession({
      role: 'initiator',
      localPrivateKey: this.identity.privateKey,
      localPublicKey: this.identity.publicKey,
      remotePublicKey: this.host.identityKey,
      prologue: createNoisePrologue(info.connectionId, this.host.deviceId, this.identity.deviceId),
    })
    this.noise = noise
    try {
      await waitForResponder(this.inner, noise, this.handshakeTimeoutMs)
    } catch (error) {
      noise.destroy()
      this.noise = undefined
      await this.inner.close()
      throw error
    }
  }

  /** Noise counters and fragment ids are not re-entrant, so sends run one at a time. */
  async send(data: Uint8Array): Promise<void> {
    const run = this.sendTail.then(() => this.sendNow(data))
    this.sendTail = run.catch(() => undefined)
    return run
  }

  onMessage(cb: (data: Uint8Array) => void): () => void {
    this.unsubscribeInner?.()
    this.unsubscribeInner = this.inner.onMessage(data => {
      const noise = this.noise
      if (noise === undefined || !noise.complete || this.closed) return
      let message: Uint8Array | undefined
      try {
        message = this.incoming.decode(noise.decrypt(data))
      } catch {
        void this.close()
        return
      }
      if (message !== undefined) cb(message)
    })
    return () => {
      this.unsubscribeInner?.()
      this.unsubscribeInner = undefined
    }
  }

  onClose(handler: () => void): () => void {
    return this.inner.onClose?.(handler) ?? (() => undefined)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unsubscribeInner?.()
    this.unsubscribeInner = undefined
    this.incoming.reset()
    this.outgoing.reset()
    this.noise?.destroy()
    this.noise = undefined
    await this.inner.close()
  }

  getStats(): TransportStats { return this.inner.getStats() }

  private async sendNow(data: Uint8Array): Promise<void> {
    const plaintextFrames = this.outgoing.encode(data)
    try {
      for (const plaintext of plaintextFrames) await this.inner.send(this.requireNoise().encrypt(plaintext))
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  private requireNoise(): NoiseIkSession {
    if (this.noise === undefined || !this.noise.complete || this.closed) throw new Error('The secure channel is not connected.')
    return this.noise
  }
}

async function waitForResponder(inner: SecureHandshakeTransport, noise: NoiseIkSession, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(new Error('The secure handshake timed out.')), timeoutMs)
    const unsubscribe = inner.onHandshake((step, data) => {
      if (settled) return
      try {
        if (step !== 2) throw new Error('The secure handshake arrived out of order.')
        noise.readHandshake(data)
        if (!noise.complete) throw new Error('The secure handshake did not complete.')
        finish()
      } catch (error) {
        finish(error instanceof Error ? error : new Error('The secure handshake failed.'))
      }
    })
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      if (error === undefined) resolve()
      else reject(error)
    }
    inner.sendHandshake(1, noise.writeHandshake()).catch(error => {
      finish(error instanceof Error ? error : new Error('The secure handshake failed.'))
    })
  })
}
