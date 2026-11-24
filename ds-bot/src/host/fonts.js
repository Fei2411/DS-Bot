// Serves the reply fonts that ship with the plugin (src/shared/reply-fonts.js), one
// exact route per file, so a theme's @font-face works offline in every client that
// loads the plugin.
import { readFile, stat } from 'node:fs/promises'
import { FONT_FILES, FONT_ROUTE } from '../shared/reply-fonts.js'

export const FONT_DIR = new URL('../../assets/fonts/', import.meta.url)

export function install(rt) {
  const { ctx } = rt
  for (const file of Object.values(FONT_FILES)) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/${FONT_ROUTE}/${file}`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(file, FONT_DIR)
        let info
        try { info = await stat(url) } catch { return new Response('Not found', { status: 404 }) }
        // The URL stays the same when an update rebuilds a font, so the browser checks
        // the tag on each load instead of keeping a copy for a fixed time.
        const etag = `"${info.size.toString(36)}-${Math.trunc(info.mtimeMs).toString(36)}"`
        const headers = { 'content-type': 'font/woff2', 'cache-control': 'no-cache', etag }
        if (request?.headers?.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
        return new Response(await readFile(url), { status: 200, headers })
      },
    }), `ds-bot: font route ${file}`)
  }
}
