import * as filesystem from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export class ChatGPTStoreError extends Error {
  constructor() { super('ChatGPT credentials could not be stored or read securely.'); this.name = 'ChatGPTStoreError' }
}

export function createChatGPTStore({ userData, safeStorage, fs = filesystem, platform = process.platform }) {
  const file = join(userData, 'chatgpt-signin.enc')
  const supported = () => {
    try {
      return safeStorage.isEncryptionAvailable()
        && !(platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    } catch { return false }
  }
  return {
    supported,
    async read() {
      if (!supported()) throw new ChatGPTStoreError()
      try {
        const record = JSON.parse(safeStorage.decryptString(await fs.readFile(file)))
        if (record.version !== 1 || typeof record.hostId !== 'string'
          || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.hostId)
          || (record.clientId !== undefined && (typeof record.clientId !== 'string' || !record.clientId || record.clientId === 'dynamic_agent_client'))
          || (record.tokens && (!record.clientId || typeof record.subject !== 'string' || typeof record.issuer !== 'string'
            || typeof record.tokens.accessToken !== 'string' || !record.tokens.accessToken
            || typeof record.tokens.refreshToken !== 'string' || !record.tokens.refreshToken
            || !Number.isFinite(record.tokens.expiresAt) || !Array.isArray(record.tokens.scopes)
            || !record.tokens.scopes.every(scope => typeof scope === 'string')))) throw new ChatGPTStoreError()
        return record
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw new ChatGPTStoreError()
      }
    },
    async write(record) {
      if (!supported()) throw new ChatGPTStoreError()
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        const encrypted = safeStorage.encryptString(JSON.stringify(record))
        await fs.mkdir(userData, { recursive: true, mode: 0o700 })
        const handle = await fs.open(temporary, 'wx', 0o600)
        try { await handle.writeFile(encrypted); await handle.sync() } finally { await handle.close() }
        await fs.rename(temporary, file)
      } catch { throw new ChatGPTStoreError() } finally {
        await fs.unlink(temporary).catch(() => {})
      }
    },
  }
}
