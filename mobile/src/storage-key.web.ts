export async function browserStorageKey(create: boolean): Promise<CryptoKey | undefined> {
  const candidate = create ? await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) : undefined
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('dsbot.web.storage', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('keys') }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const transaction = db.transaction('keys', create ? 'readwrite' : 'readonly')
      const store = transaction.objectStore('keys')
      const request = store.get('encryption')
      let key: CryptoKey | undefined
      request.onsuccess = () => {
        key = request.result
        if (key === undefined && candidate !== undefined) {
          key = candidate
          store.put(key, 'encryption')
        }
      }
      transaction.oncomplete = () => resolve(key)
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser key storage failed'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Browser key storage failed'))
    })
  } finally { db.close() }
}
