import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class LinkError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

export interface DeviceRecord {
  role: 'host' | 'client'
  identityKey: string
  tokenHash: string
  firstSeen: number
  lastSeen: number
}

const MAX_DEVICES = 100_000

/**
 * The devices the Server has seen. A device claims its id with its first token;
 * later connections must bring the same token. The Server holds no account and
 * no message content.
 */
export class DeviceStore {
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly file?: string
  private saveTimer?: ReturnType<typeof setTimeout>

  constructor(file?: string) {
    this.file = file
    if (file === undefined) return
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, DeviceRecord>
      for (const [id, record] of Object.entries(saved)) this.devices.set(id, record)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  get(deviceId: string): DeviceRecord | undefined { return this.devices.get(deviceId) }

  /** Checks a hello and records the device on first sight. */
  admit(deviceId: string, role: 'host' | 'client', identityKey: string, accessToken: string): DeviceRecord {
    const tokenHash = hash(accessToken)
    const known = this.devices.get(deviceId)
    if (known !== undefined) {
      if (known.role !== role || known.identityKey !== identityKey || !sameHash(known.tokenHash, tokenHash)) {
        throw new LinkError('AUTH_INVALID')
      }
      known.lastSeen = Date.now()
      this.scheduleSave()
      return known
    }
    if (this.devices.size >= MAX_DEVICES) throw new LinkError('SERVER_FULL')
    const record: DeviceRecord = { role, identityKey, tokenHash, firstSeen: Date.now(), lastSeen: Date.now() }
    this.devices.set(deviceId, record)
    this.scheduleSave()
    return record
  }

  flush(): void {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    if (this.file === undefined) return
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, `${JSON.stringify(Object.fromEntries(this.devices))}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
  }

  private scheduleSave(): void {
    if (this.file === undefined || this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => this.flush(), 1_000)
    this.saveTimer.unref()
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
