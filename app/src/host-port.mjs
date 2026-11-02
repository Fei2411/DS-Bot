// The window's origin is the Host's loopback address, and the page keeps its storage (unread
// marks, layout, preferences) per origin, so the Host listens on the same port at every start.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'

const free = port => new Promise((resolve) => {
  const server = createServer()
  server.once('error', () => { resolve(undefined) })
  server.listen(port, '127.0.0.1', () => {
    const { port: bound } = server.address()
    server.close(() => { resolve(bound) })
  })
})

const saved = (file) => {
  try {
    const { port } = JSON.parse(readFileSync(file, 'utf8'))
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
  } catch {
    return undefined
  }
}

/**
 * The port saved in `file` while it is free, otherwise a new free one, which is saved.
 * @param {string} file
 * @returns {Promise<number>}
 */
export async function hostPort(file) {
  const kept = saved(file)
  const port = (kept === undefined ? undefined : await free(kept)) ?? await free(0)
  if (port === undefined) throw new Error('DS Bot: no free port on 127.0.0.1')
  if (port !== kept) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ port })}\n`)
  }
  return port
}
