export function browserPairingUrl(server, browserUri) {
  const url = new URL(server)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('The Server address must start with ws:// or wss://')
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = `${url.pathname.replace(/\/v1\/link\/?$/, '').replace(/\/+$/, '')}/web/`
  url.search = ''
  url.hash = `pair=${encodeURIComponent(browserUri)}`
  return url.href
}
