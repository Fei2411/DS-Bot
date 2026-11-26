// A bounded response fits the encrypted link; consumers write each chunk before asking for more.
/**
 * @param {(endpoint: string, payload: object) => Promise<any>} call
 * @param {object} target
 */
export async function* fileChunks(call, target) {
  let offset = 0
  let version
  for (;;) {
    const part = await call('file-download', { ...target, offset, ...(version === undefined ? {} : { version }) })
    const bytes = Uint8Array.from(atob(part.bytes), char => char.charCodeAt(0))
    // Older hosts return one whole file without chunk metadata.
    if (part.nextOffset === undefined) { yield { ...part, data: bytes }; return }
    if (part.nextOffset !== offset + bytes.length || (part.done !== true && bytes.length === 0)
      || (version !== undefined && version !== part.version)) throw new Error('This file is no longer available')
    yield { ...part, data: bytes }
    if (part.done === true) return
    offset = part.nextOffset
    version = part.version
  }
}
