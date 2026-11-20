import { fileChunks } from '../../../ds-bot/src/shared/file-chunks.js'

export async function downloadFile(call: (endpoint: string, payload: object) => Promise<unknown>, target: object) {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let name = 'file'
  let mime = 'application/octet-stream'
  for await (const part of fileChunks(call, target)) {
    if (chunks.length === 0) {
      name = String(part.name || 'file').replace(/[\\/\u0000-\u001f]/g, '_')
      if (name === '.' || name === '..') name = 'file'
      mime = part.mime || mime
    }
    chunks.push(new Uint8Array(part.data))
  }
  return { uri: URL.createObjectURL(new Blob(chunks, { type: mime })), name, mime }
}
