import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

// A minimal RFC 6455 server for adapter tests: the handshake, masked frame
// decode, unmasked send. Text only, no fragmentation beyond reassembly.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const encode = (data, opcode = 0x81) => {
  const payload = Buffer.from(data)
  const length = payload.length
  const head = length < 126 ? 2 : length < 65536 ? 4 : 10
  const frame = Buffer.alloc(head + length)
  frame[0] = opcode
  if (length < 126) frame[1] = length
  else if (length < 65536) { frame[1] = 126; frame.writeUInt16BE(length, 2) }
  else { frame[1] = 127; frame.writeBigUInt64BE(BigInt(length), 2) }
  payload.copy(frame, head)
  return frame
}

// onSocket(socket) runs per connection; socket.send(text) / socket.close() and
// socket.on('message'|'close'). checkUpgrade(req) may refuse a handshake by
// returning an HTTP status. Returns { server, url, sockets } once listening.
export function fakeWsServer({ onSocket, onRequest, checkUpgrade } = {}) {
  const sockets = []
  const pending = onRequest ?? (() => undefined)
  const server = createServer((req, res) => {
    const answer = pending(req)
    if (answer === undefined) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer))
  })
  server.on('upgrade', (req, socket) => {
    const refusal = checkUpgrade?.(req)
    if (typeof refusal === 'number') {
      socket.end(`HTTP/1.1 ${refusal} Upgrade Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const key = req.headers['sec-websocket-key'] ?? randomBytes(16).toString('base64')
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const ws = {
      send: data => socket.write(encode(data, Buffer.isBuffer(data) ? 0x82 : 0x81)),
      close: () => {
        try { socket.write(encode('', 0x88)) } catch { /* down */ }
        try { socket.destroy() } catch { /* down */ }
      },
      listeners: { message: [], close: [] },
      on(kind, fn) { this.listeners[kind].push(fn) },
    }
    sockets.push(ws)
    let buffer = Buffer.alloc(0)
    const pieces = []
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 2) {
        const fin = (buffer[0] & 0x80) !== 0
        const opcode = buffer[0] & 0x0f
        const masked = (buffer[1] & 0x80) !== 0
        let length = buffer[1] & 0x7f
        let at = 2
        if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); at = 4 }
        else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); at = 10 }
        const maskAt = at
        if (masked) at += 4
        if (buffer.length < at + length) break
        let payload = buffer.subarray(at, at + length)
        if (masked) {
          const mask = buffer.subarray(maskAt, maskAt + 4)
          payload = Buffer.from(payload)
          for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
        }
        buffer = buffer.subarray(at + length)
        if (opcode === 8) {
          socket.write(encode('', 0x88))
          socket.end()
          for (const fn of ws.listeners.close) fn()
          continue
        }
        if (opcode === 9) { socket.write(encode('', 0x8a)); continue }
        pieces.push(payload)
        if (!fin) continue
        const joined = Buffer.concat(pieces)
        pieces.length = 0
        const body = opcode === 2 ? joined : joined.toString('utf8')
        for (const fn of ws.listeners.message) fn(body)
      }
    })
    socket.on('close', () => { for (const fn of ws.listeners.close) fn() })
    socket.on('error', () => {})
    onSocket?.(ws)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const url = `ws://127.0.0.1:${server.address().port}`
    resolve({ server, url, sockets, close: () => { for (const ws of sockets) try { ws.close() } catch { /* down */ } server.closeAllConnections?.(); server.close() } })
  }))
}
