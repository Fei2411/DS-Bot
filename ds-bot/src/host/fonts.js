// Serves the reply fonts that ship with the plugin (src/shared/reply-fonts.js), one
// exact route per file, so a theme's @font-face works offline in every client that
// loads the plugin.
import { readFile } from 'node:fs/promises'
import { FONT_FILES, FONT_ROUTE } from '../shared/reply-fonts.js'

export const FONT_DIR = new URL('../../assets/fonts/', import.meta.url)

export function install(rt) {
  const { ctx } = rt
  for (const file of Object.values(FONT_FILES)) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/${FONT_ROUTE}/${file}`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        let body
        try { body = await readFile(new URL(file, FONT_DIR)) } catch { return new Response('Not found', { status: 404 }) }
        return new Response(body, { status: 200, headers: { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=86400' } })
      },
    }), `ds-bot: font route ${file}`)
  }
}
