import { browserStorageKey } from './storage-key.web.ts'

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 0

export function createEncryptedStorage(store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, loadKey: (create: boolean) => Promise<CryptoKey | undefined>) {
  const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
  const decode = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0))
  const pending = new Map<string, Promise<void>>()
  const enqueue = <T>(name: string, operation: () => T | Promise<T>): Promise<T> => {
    const result = (pending.get(name) ?? Promise.resolve()).then(operation)
    const settled = result.then(() => {}, () => {})
    pending.set(name, settled)
    void settled.then(() => { if (pending.get(name) === settled) pending.delete(name) })
    return result
  }
  return {
    getItemAsync(name: string, _options?: unknown): Promise<string | null> {
      return enqueue(name, async () => {
        const text = store.getItem(name)
        if (text === null) return null
        let value: { version: number; iv: string; ciphertext: string }
        try {
          value = JSON.parse(text)
          if (value?.version !== 1 || typeof value.iv !== 'string' || typeof value.ciphertext !== 'string') return null
        } catch { return null }
        const key = await loadKey(false)
        if (key === undefined) return null
        try {
          const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv), additionalData: new TextEncoder().encode(name) }, key, decode(value.ciphertext))
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch { return null }
      })
    },
    setItemAsync(name: string, value: string, _options?: unknown): Promise<void> {
      return enqueue(name, async () => {
        const key = await loadKey(true)
        if (key === undefined) throw new Error('Browser key storage failed')
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) }, key, new TextEncoder().encode(value))
        store.setItem(name, JSON.stringify({ version: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) }))
      })
    },
    deleteItemAsync(name: string, _options?: unknown): Promise<void> { return enqueue(name, () => store.removeItem(name)) },
  }
}

export const { getItemAsync, setItemAsync, deleteItemAsync } = createEncryptedStorage({
  getItem: name => localStorage.getItem(name),
  setItem: (name, value) => localStorage.setItem(name, value),
  removeItem: name => localStorage.removeItem(name),
}, browserStorageKey)
