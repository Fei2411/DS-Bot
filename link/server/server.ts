import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Gateway } from './gateway.ts'
import { DeviceStore } from './store.ts'

export const LINK_PATH = '/v1/link'

export interface RelayServerOptions {
  port?: number
  host?: string
  dataFile?: string
}

export interface RelayServer {
  /** The WebSocket address phones and computers connect to. */
  url: string
  close(): Promise<void>
}

const VERSION = 'ds-bot-link/0.1.0'

export async function startRelayServer(options: RelayServerOptions = {}): Promise<RelayServer> {
  const store = new DeviceStore(options.dataFile)
  const gateway = new Gateway({ store, serverVersion: VERSION })
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n')
      return
    }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://local').pathname !== LINK_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    gateway.handleUpgrade(req, socket, head)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const { address, port } = server.address() as AddressInfo
  const shown = address.includes(':') ? `[${address}]` : address
  return {
    url: `ws://${shown}:${port}${LINK_PATH}`,
    async close() {
      gateway.close()
      store.flush()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
