// The engine's index: the app shell opens the Host's launch URL here and trades its token for the Host
// cookie. The window's page comes from the shell, so the index serves nothing else.

export const name = 'dsbot-engine'
export const inject = ['webServer', 'connection']

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.registerFallback((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (req.method !== 'GET' || pathname !== '/') {
      res.writeHead(404)
      res.end()
      return
    }
    if (!ctx.connection.authorizeIndex(req, res)) return
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  }), 'dsbot-engine: launch-token exchange')
}
