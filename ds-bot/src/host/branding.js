import { readFileSync } from 'node:fs'

const asset = name => readFileSync(new URL(`../../assets/pwa/${name}`, import.meta.url))

const MANIFEST = JSON.stringify({
  name: 'DS Bot',
  short_name: 'DS Bot',
  start_url: '../',
  scope: '../',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#ffffff',
  icons: [
    { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2) + '\n'

// Keep every URL relative to the index or manifest. A reverse proxy that mounts
// DSH below a path prefix then resolves the same routes without configuration.
export function brandHtml(html) {
  return html
    .replace('<title>DeepSeek Harness</title>', '<title>DS Bot</title>')
    .replace('content="DSH"', 'content="DS Bot"')
    .replace('href="./manifest.webmanifest"', 'href="./ds-bot/manifest.webmanifest"')
    .replace('href="./apple-touch-icon.png"', 'href="./ds-bot/apple-touch-icon.png"')
    .replaceAll(/href="\.\/favicon(?:-dark)?\.svg"/g, 'href="./ds-bot/icon.svg"')
}

function reply(response, type, body) {
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
  response.end(body)
}

export function install(rt) {
  const web = rt.ctx.get?.('webServer')
  if (!web) return
  rt.ctx.effect(() => web.tapIndex(brandHtml), 'ds-bot: PWA name and icons')

  const routes = [
    ['manifest.webmanifest', 'application/manifest+json; charset=utf-8', MANIFEST],
    ['icon.svg', 'image/svg+xml', asset('icon.svg')],
    ['apple-touch-icon.png', 'image/png', asset('apple-touch-icon.png')],
    ['icon-192.png', 'image/png', asset('icon-192.png')],
    ['icon-512.png', 'image/png', asset('icon-512.png')],
    ['icon-maskable-512.png', 'image/png', asset('icon-maskable-512.png')],
  ]
  for (const [name, type, body] of routes) {
    rt.ctx.effect(() => web.register({
      kind: 'exact',
      path: `/ds-bot/${name}`,
      handler: (request, response) => reply(response, type, body),
    }), `ds-bot: PWA ${name}`)
  }
}
