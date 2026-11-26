// Side Apps: the host half of the Canvas and Reader workbench (design:
// docs/plans/2026-11-25-side-app-workbench.md). The `open_canvas` and `open_reader`
// team tools validate a workspace file and leave a reopenable card; the `/api/bot`
// endpoints authorize every open/read/diff/preview again against the Session's own
// working root; and a ticketed web-server route serves a Canvas entry document and
// its same-directory assets to the sandboxed preview iframe.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'
import { within } from './folders.js'

export const CANVAS_EXTENSIONS = new Set(['.html', '.htm'])
export const READER_EXTENSIONS = new Set(['.md', '.markdown', '.mdx'])
export const TEXT_LIMIT = 4 * 1024 * 1024
export const HTML_LIMIT = 8 * 1024 * 1024
const ASSET_LIMIT = 16 * 1024 * 1024
// A ticket lives only in this process's memory. The client renews it while its
// Render tab is on screen; nobody else may ever learn it.
const TICKET_TTL_MS = 10 * 60_000
// The manifest walks the asset tree with bounds: past them it keeps serving but the
// revision only follows the entry document.
const MANIFEST_FILES_MAX = 400
const MANIFEST_DEPTH_MAX = 4
const MANIFEST_BYTES_MAX = 2 * 1024 * 1024
// Diff bases keep whole copies of file text; cap both so a busy turn cannot exhaust the host.
const DIFF_FILES_MAX = 32
const DIFF_TEXT_MAX = 2 * 1024 * 1024
const DIFF_KEEP_MS = 60 * 60_000
// A foreground window learns of a fresh open within moments; older entries mean no
// window consumed them and stay only as cards in the transcript.
const OPEN_KEEP_MS = 30 * 60_000
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch'])

const invalid = (message) => Object.assign(new Error(message), { code: 'bot/invalid' })
const notFound = (message) => Object.assign(new Error(message), { code: 'bot/not-found' })
const forbidden = (message) => Object.assign(new Error(message), { code: 'bot/forbidden' })
const tooLarge = (message) => Object.assign(new Error(message), { code: 'bot/too-large' })
const workspaceChanged = (message) => Object.assign(new Error(message), { code: 'bot/workspace-changed' })

const sha = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 24)
const foldKey = path => (process.platform === 'linux' ? path : path.toLowerCase())

// Resource types a Canvas document may pull in. Everything else is refused, so the
// served tree cannot become a general file read.
const ASSET_MIMES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.pdf', 'application/pdf'],
])
// A draft's files are untrusted but local; names that commonly hold credentials or
// machine state never leave the host, whatever their extension.
const SENSITIVE_NAME = /(?:^|[\\/])(?:\.env(?:\.\w+)?|\.git(?:[\\/].*)?|\.ssh(?:[\\/].*)?|\.gnupg(?:[\\/].*)?|\.aws(?:[\\/].*)?|\.npmrc|\.netrc|\.pypirc|\.htpasswd|id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts|secrets?\.(?:json|ya?ml|toml|env)|credentials?(?:\.(?:json|ya?ml|toml|env))?|(?:server|private|client)[-.]key\.(?:pem|key)|[^\s\\/]+\.(?:pem|key|p12|pfx|keystore|jks|kdbx))$/i

// Scripts run because a draft is meant to be interactive; everything that would let
// them reach the network, the host, or another frame is off. The CSP sandbox mirrors
// the iframe's sandbox attribute so a document opened outside it (shared link, a new
// tab) keeps an opaque origin instead of inheriting the host page's.
const CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const esc = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const errorPage = (status, message) => new Response(
  `<!doctype html><meta charset="utf-8"><title>${status}</title><body style="font:13px/1.5 system-ui;padding:24px;color:#666">${esc(message)}</body>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } },
)

// Strict UTF-8 validation: the state machine rejects any byte sequence that is not
// scalar-valued text, so a binary or Latin-1 file never shows as mojibake.
function isUtf8(bytes) {
  let at = 0
  while (at < bytes.length) {
    const byte = bytes[at]
    if (byte < 0x80) {
      at += 1
      continue
    }
    let need
    let min
    let code
    if ((byte & 0xe0) === 0xc0) {
      need = 1
      min = 0x80
      code = byte & 0x1f
    } else if ((byte & 0xf0) === 0xe0) {
      need = 2
      min = 0x800
      code = byte & 0x0f
    } else if ((byte & 0xf8) === 0xf0) {
      need = 3
      min = 0x10000
      code = byte & 0x07
    } else {
      return false
    }
    if (at + need >= bytes.length) return false
    for (let index = 1; index <= need; index += 1) {
      const next = bytes[at + index]
      if ((next & 0xc0) !== 0x80) return false
      code = (code << 6) | (next & 0x3f)
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false
    at += need + 1
  }
  return true
}

export function install(rt) {
  const { ctx } = rt

  // ---- the working root ------------------------------------------------------

  // The one root a Session's Side Apps may read in V1: the folder its own working
  // directory resolves to. Plans widen it (extra folders, historical roots) only
  // with separate authorization evidence.
  async function workRootOf(session) {
    // A Session's own immutable cwd is authoritative and needs no registry; the
    // session folder may have moved since (working_directory), so it wins when
    // the runtime can read it — which can throw where services are missing.
    let folder
    try {
      folder = rt.sessionFolder?.(session)
    } catch {
      folder = undefined
    }
    if (typeof folder !== 'string' || folder === '') folder = session?.header?.cwd
    if (typeof folder !== 'string' || folder === '') return undefined
    return (await rt.realBeyond?.(folder).catch(() => undefined)) ?? (await rt.real?.(folder).catch(() => undefined)) ?? resolve(folder)
  }

  const rootTag = root => sha(Buffer.from(foldKey(root), 'utf8'))

  // Resolve `raw` inside `root` and prove the real target stays inside it.
  async function resolveInRoot(root, raw) {
    const input = String(raw ?? '').trim()
    if (input === '') throw invalid('No file named')
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) throw invalid('Give a workspace file path, not a URL')
    const candidate = resolve(root, input)
    const real = (await rt.realBeyond?.(candidate).catch(() => undefined)) ?? (await rt.real?.(candidate).catch(() => undefined)) ?? candidate
    if (!within(real, root)) throw forbidden('That path leaves the working folder')
    if (await rt.inData?.(real)) throw forbidden('That path is inside DeepSeek Harness or team data, which cannot be opened here')
    const rootPrefix = root.endsWith(sep) ? root : root + sep
    const displayPath = (real === root ? basename(real) : real.startsWith(rootPrefix) ? real.slice(rootPrefix.length) : basename(real)).split(sep).join('/')
    return { realPath: real, displayPath, root }
  }

  // A descriptor claims a file beside its own document; the subtree proof binds the
  // bytes to that document instead of the whole working root. The document itself is
  // validated as the kind its app reads, so a card cannot re-anchor to an unrelated file.
  async function resolveSiblingOf(root, documentPath, target) {
    const document = await resolveInRoot(root, documentPath)
    if (!within(target.realPath, dirname(document.realPath))) throw forbidden('That file is not inside the document folder')
    if (await rt.inData?.(target.realPath)) throw forbidden('That path is inside DeepSeek Harness or team data, which cannot be opened here')
    return document
  }

  async function statTarget(realPath) {
    const info = await stat(realPath).catch(() => undefined)
    if (info === undefined) throw notFound('The file is no longer there')
    if (!info.isFile()) throw invalid('That path is not a file')
    return info
  }

  const fileKind = (app, realPath) => {
    const ext = extname(realPath).toLowerCase()
    if (app === 'canvas') {
      if (!CANVAS_EXTENSIONS.has(ext)) throw invalid(`Canvas opens HTML files (.html/.htm), not ${ext || 'this file'}`)
    } else if (!READER_EXTENSIONS.has(ext)) throw invalid(`Reader opens Markdown files (.md/.markdown/.mdx), not ${ext || 'this file'}`)
    return ext
  }

  // ---- diff bases -------------------------------------------------------------
  // The before/after text a `ctx.fs` write hands its caller, captured as the write's
  // tool result passes. Per file the first before and the last after of a turn form
  // one base; shell redirection and outside editors never produce one, which the
  // plan accepts as the client-snapshot case.
  /** @type {Map<string, {realPath:string, before:string, after:string, baseRevision:string, afterRevision:string, turn?:number, sessionId:string, at:number}>} */
  const diffBases = new Map()

  const sweepDiffs = (now = Date.now()) => {
    for (const [key, entry] of diffBases) if (now - entry.at > DIFF_KEEP_MS) diffBases.delete(key)
    while (diffBases.size > DIFF_FILES_MAX) diffBases.delete(diffBases.keys().next().value)
  }

  // The tool result of a write: probe every plausible carrier of the before/after
  // pair. DSH's fs contract hands `before`/`after` to the mutation caller; where the
  // tool result keeps them (value, meta, or the top level) differs by version, so
  // all three are tried and the unit tests pin the shape down.
  const writePair = (result) => {
    for (const candidate of [result?.value, result?.meta, result]) {
      if (candidate === null || typeof candidate !== 'object') continue
      const source = Object.hasOwn(candidate, 'before') || Object.hasOwn(candidate, 'after')
        ? candidate
        : (candidate.details !== null && typeof candidate.details === 'object' ? candidate.details : undefined)
      if (source === undefined || !Object.hasOwn(source, 'before') || typeof source.after !== 'string') continue
      if (typeof source.before === 'string') return { before: source.before, after: source.after, created: false }
      if (source.before === null) return { before: '', after: source.after, created: true }
    }
    return undefined
  }

  // Every before/after pair a write's result carries: single-file tools have theirs
  // at the top of the result value; apply_patch lists one change per operation. A
  // deletion (after: null) leaves no base — there is no text to compare against.
  const writePairs = (result) => {
    const pairs = []
    const single = writePair(result)
    if (single !== undefined) pairs.push(single)
    const changes = result?.value?.operations
    if (Array.isArray(changes)) {
      for (const operation of changes) {
        for (const change of operation?.changes ?? []) {
          if (typeof change?.path === 'string' && typeof change.after === 'string' && (typeof change.before === 'string' || change.before === null)) {
            pairs.push({ before: change.before ?? '', after: change.after, created: change.before === null, path: change.path })
          }
        }
      }
    }
    return pairs
  }

  const rememberDiffBase = async (session, agentId, raw, pair) => {
    if (pair.before.length > DIFF_TEXT_MAX || pair.after.length > DIFF_TEXT_MAX) return
    const root = await workRootOf(session)
    if (root === undefined) return
    let target
    try {
      target = await resolveInRoot(root, raw)
    } catch {
      return
    }
    const key = foldKey(target.realPath)
    const turn = rt.live?.get(agentId)?.turn
    const entry = {
      realPath: target.realPath,
      before: pair.before,
      after: pair.after,
      baseRevision: sha(Buffer.from(pair.before, 'utf8')),
      afterRevision: sha(Buffer.from(pair.after, 'utf8')),
      ...(Number.isInteger(turn) ? { turn } : {}),
      sessionId: agentId ?? session.id,
      at: Date.now(),
    }
    const earlier = diffBases.get(key)
    if (earlier !== undefined && earlier.turn === entry.turn && earlier.sessionId === entry.sessionId) {
      // Several writes in one turn diff from the first before to the last after.
      entry.before = earlier.before
      entry.baseRevision = earlier.baseRevision
    }
    diffBases.delete(key)
    diffBases.set(key, entry)
  }

  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    try {
      if (!WRITE_TOOLS.has(exec.name) || result?.isError === true) return result
      const session = exec.agent?.session
      if (session === undefined) return result
      const pairs = writePairs(result)
      if (pairs.length === 0) return result
      const args = exec.arguments ?? {}
      const fallbackPath = args.file_path ?? args.path
      for (const pair of pairs) {
        const raw = pair.path ?? fallbackPath
        if (typeof raw === 'string' && raw !== '') await rememberDiffBase(session, exec.agent?.id, raw, pair)
      }
      sweepDiffs()
    } catch { /* a diff base is a bonus; a capture failure never breaks the write */ }
    return result
  })

  // ---- preview tickets --------------------------------------------------------
  /** @type {Map<string, {id:string, entryReal:string, entryName:string, root:string, displayPath:string, sessionId:string, createdAt:number, expiresAt:number}>} */
  const tickets = new Map()

  const sweepTickets = (now = Date.now()) => {
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id)
  }

  function issueTicket({ entryReal, displayPath, sessionId }) {
    sweepTickets()
    const id = randomBytes(24).toString('base64url')
    const now = Date.now()
    // The resource root is the entry document's own directory: nothing outside it
    // can ever be served, however the document spells its links.
    tickets.set(id, {
      id,
      entryReal,
      entryName: basename(entryReal),
      root: dirname(entryReal),
      displayPath,
      sessionId,
      createdAt: now,
      expiresAt: now + TICKET_TTL_MS,
    })
    return tickets.get(id)
  }

  function renewTicket(id, sessionId) {
    const ticket = tickets.get(id)
    if (ticket === undefined || (sessionId !== undefined && ticket.sessionId !== sessionId)) return undefined
    if (ticket.expiresAt <= Date.now()) {
      tickets.delete(id)
      return undefined
    }
    ticket.expiresAt = Date.now() + TICKET_TTL_MS
    return ticket
  }

  // The manifest: the entry bytes in full, plus the asset tree's metadata and the
  // bytes of small assets, so a change anywhere the document can reach refreshes
  // the preview. Metadata-only for large assets: a size/mtime change is enough,
  // and both change on write through the host's own tools.
  async function previewRevision(ticket) {
    const hash = createHash('sha256')
    let counted = 0
    let truncated = false
    const entryBytes = await readFile(ticket.entryReal)
    hash.update(entryBytes)
    const walk = async (dir, depth) => {
      if (depth > MANIFEST_DEPTH_MAX) {
        truncated = true
        return
      }
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const full = resolve(dir, entry.name)
        const real = (await rt.realBeyond?.(full).catch(() => undefined)) ?? (await rt.real?.(full).catch(() => undefined)) ?? full
        if (!within(real, ticket.root)) continue
        if (entry.isDirectory()) {
          await walk(real, depth + 1)
          continue
        }
        if (!entry.isFile() || real === ticket.entryReal) continue
        const ext = extname(entry.name).toLowerCase()
        if (!ASSET_MIMES.has(ext) || SENSITIVE_NAME.test(real)) continue
        const info = await stat(real).catch(() => undefined)
        if (info === undefined || info.size > ASSET_LIMIT) continue
        counted += 1
        if (counted > MANIFEST_FILES_MAX) {
          truncated = true
          continue
        }
        hash.update('\0file\0')
        hash.update(real.slice(ticket.root.length))
        hash.update(String(info.size))
        hash.update(String(Math.floor(info.mtimeMs)))
        if (info.size <= MANIFEST_BYTES_MAX) hash.update(await readFile(real).catch(() => Buffer.alloc(0)))
      }
    }
    await walk(ticket.root, 0)
    if (truncated) hash.update('\0truncated\0')
    return { revision: hash.digest('hex').slice(0, 24), truncated }
  }

  // ---- the canvas web route ---------------------------------------------------
  const CANVAS_ROUTE = '/api/bot-canvas'

  const serveAsset = async (ticket, pathname) => {
    const prefix = `${CANVAS_ROUTE}/${ticket.id}/`
    const rest = pathname.slice(prefix.length)
    let rel
    try {
      rel = decodeURIComponent(rest)
    } catch {
      return errorPage(400, 'Bad path')
    }
    if (rel === '' || rel.endsWith('/')) return errorPage(404, 'Not found')
    const candidate = resolve(ticket.root, rel)
    const real = (await rt.realBeyond?.(candidate).catch(() => undefined)) ?? (await rt.real?.(candidate).catch(() => undefined)) ?? candidate
    if (real !== ticket.entryReal) {
      if (!within(real, ticket.root)) return errorPage(404, 'Not found')
      if (rel.split('/').some(part => part === '..' || part === '.' || part.startsWith('.'))) return errorPage(404, 'Not found')
      if (SENSITIVE_NAME.test(real)) return errorPage(404, 'Not found')
      if (await rt.inData?.(real)) return errorPage(404, 'Not found')
    }
    const ext = extname(real).toLowerCase()
    const mime = ASSET_MIMES.get(ext)
    if (mime === undefined) return errorPage(404, 'Not found')
    const limit = ext === '.html' || ext === '.htm' ? HTML_LIMIT : ASSET_LIMIT
    const info = await stat(real).catch(() => undefined)
    if (info === undefined || !info.isFile()) return errorPage(404, 'Not found')
    if (info.size > limit) return errorPage(413, 'Too large')
    const bytes = await readFile(real).catch(() => undefined)
    if (bytes === undefined) return errorPage(404, 'Not found')
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': mime,
        'content-length': String(bytes.length),
        'cache-control': 'no-store',
        'content-security-policy': CSP,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  const webServer = ctx.get?.('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: CANVAS_ROUTE,
      handler: async (req, res) => {
        const method = String(req.method ?? 'GET').toUpperCase()
        const write = async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
          if (method === 'HEAD') {
            res.end()
            return
          }
          res.end(Buffer.from(await response.arrayBuffer()))
        }
        if (method !== 'GET' && method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
          res.end('Method not allowed')
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://canvas.invalid')
          const segments = url.pathname.slice(CANVAS_ROUTE.length).split('/').filter(part => part !== '')
          const id = segments[0] ?? ''
          const ticket = tickets.get(id)
          if (ticket === undefined || ticket.expiresAt <= Date.now() || segments.length < 2) {
            await write(errorPage(404, 'This preview is no longer available; refresh it from the Canvas tab.'))
            return
          }
          // The ticket itself is the authorization: this route answers any browser
          // that presents it, never a cookie, and it only ever serves files inside
          // the entry document's own directory.
          await write(await serveAsset(ticket, url.pathname))
        } catch (error) {
          rt.warn('ds-bot: canvas route failed: %s', error?.message ?? error)
          await write(errorPage(500, 'The preview could not be served.'))
        }
      },
    }), 'ds-bot: canvas route')
  }

  const frameUrl = (ticket) => {
    const server = ctx.get?.('webServer')
    let origin = ''
    try {
      origin = typeof server?.getOrigin === 'function' ? server.getOrigin() : ''
    } catch {
      origin = ''
    }
    return `${origin}${CANVAS_ROUTE}/${ticket.id}/${encodeURIComponent(ticket.entryName)}`
  }

  // ---- shared authorization ---------------------------------------------------
  // Every endpoint re-proves what the descriptor claims: the session is a team
  // conversation, its current working root still carries the tag the card was
  // issued with, and the path inside it passes the same checks as the first open.
  async function authorizeFile(body, { app } = {}) {
    const file = body?.file
    if (file === null || typeof file !== 'object') throw invalid('No file named')
    const sessionId = String(body.sessionId ?? file.sessionId ?? '')
    const past = rt.pastOwners.get(sessionId)
    const ownerBot = rt.chatOwners.get(sessionId) ?? past?.botId
    const roomId = rt.roomOf(sessionId)?.id ?? rt.groupOwners.get(sessionId)?.roomId ?? past?.roomId
    if (ownerBot === undefined && roomId === undefined) throw notFound('Unknown session')
    const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
    const root = await workRootOf(agent?.session)
    if (root === undefined) throw invalid('This conversation has no working folder here')
    if (typeof file.workspaceTag !== 'string' || file.workspaceTag !== rootTag(root)) {
      throw workspaceChanged('The working folder changed since this card was written; open the file again')
    }
    if (app !== undefined && file.app !== app) throw invalid('That card belongs to another app')
    if (typeof file.displayPath !== 'string' || file.displayPath === '') throw invalid('No file named')
    const target = await resolveInRoot(root, file.displayPath)
    return { sessionId, target, root, agent, app: file.app }
  }

  // ---- endpoints ---------------------------------------------------------------

  async function sideAppOpen(body) {
    const app = body?.app === 'canvas' || body?.app === 'reader' ? body.app : undefined
    if (app === undefined) throw invalid('app must be canvas or reader')
    const { target } = await authorizeFile(body, { app })
    const ext = fileKind(app, target.realPath)
    const info = await statTarget(target.realPath)
    if (app === 'canvas' && info.size > HTML_LIMIT) throw tooLarge('The HTML file is larger than 8 MiB')
    const revision = sha(await readFile(target.realPath))
    return {
      file: { app, displayPath: target.displayPath, workspaceTag: rootTag(target.root) },
      revision,
      size: info.size,
      previewAvailable: app === 'canvas' && info.size <= HTML_LIMIT,
      textLimited: info.size > TEXT_LIMIT,
      extension: ext,
    }
  }

  async function sideAppRead(body) {
    const { target, app } = await authorizeFile(body)
    // The card's app binds what may be read: a canvas card never reads Markdown and a
    // reader card never reads HTML, however the caller rewrites displayPath.
    fileKind(app, target.realPath)
    const info = await statTarget(target.realPath)
    const isHtml = CANVAS_EXTENSIONS.has(extname(target.realPath).toLowerCase())
    if (isHtml && info.size > HTML_LIMIT) throw tooLarge('The HTML file is larger than 8 MiB')
    if (info.size > TEXT_LIMIT) throw tooLarge('The file is larger than 4 MiB of text')
    const bytes = await readFile(target.realPath)
    if (!isUtf8(bytes)) throw invalid('The file is not valid UTF-8 text')
    const revision = sha(bytes)
    if (typeof body.knownRevision === 'string' && body.knownRevision === revision) return { kind: 'unchanged', revision }
    return { kind: 'text', revision, text: bytes.toString('utf8'), size: bytes.length }
  }

  // Images a Markdown document may embed. Documents stay text-only; bytes go only
  // to types a browser renders as inert images, never HTML or scripts.
  const IMAGE_MIMES = new Map([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.avif', 'image/avif'],
    ['.svg', 'image/svg+xml'],
  ])
  const IMAGE_LIMIT = 4 * 1024 * 1024

  // Raw bytes of one workspace image for the reader. Beyond the root and tag the card
  // authorizes, the caller names the article it renders (`file.article`): the image
  // must sit inside that article's own directory, so the endpoint never widens into a
  // general workspace image read.
  async function sideAppBytes(body) {
    const { target, root, app } = await authorizeFile(body)
    if (app !== 'reader') throw invalid('Only the Reader reads image bytes here')
    const article = body?.file?.article
    if (typeof article !== 'string' || article === '') throw invalid('Name the article this image belongs to')
    const document = await resolveSiblingOf(root, article, target)
    const documentExt = extname(document.realPath).toLowerCase()
    if (!READER_EXTENSIONS.has(documentExt)) throw invalid('The article is not a Markdown document')
    const ext = extname(target.realPath).toLowerCase()
    const mime = IMAGE_MIMES.get(ext)
    if (mime === undefined) throw invalid(`Only image files can be read here (png, jpg, gif, webp, avif, svg), not ${ext || 'this file'}`)
    const info = await statTarget(target.realPath)
    if (info.size > IMAGE_LIMIT) throw tooLarge('The image is larger than 4 MiB')
    const bytes = await readFile(target.realPath)
    const revision = sha(bytes)
    if (typeof body.knownRevision === 'string' && body.knownRevision === revision) return { kind: 'unchanged', revision }
    return { kind: 'bytes', revision, mime, size: bytes.length, data: bytes.toString('base64') }
  }

  async function sideAppDiff(body) {
    const { sessionId, target } = await authorizeFile(body)
    const revision = typeof body.revision === 'string' ? body.revision : ''
    const entry = diffBases.get(foldKey(target.realPath))
    // A base answers only the conversation whose writes produced it, while it is young:
    // another session editing the same file or an hour-old write is the client-snapshot case.
    if (
      entry === undefined || revision === '' || entry.afterRevision !== revision
      || entry.sessionId !== sessionId || Date.now() - entry.at > DIFF_KEEP_MS
    ) return { kind: 'unavailable' }
    return {
      kind: 'host',
      before: entry.before,
      baseRevision: entry.baseRevision,
      revision: entry.afterRevision,
      ...(entry.turn !== undefined ? { turn: entry.turn } : {}),
    }
  }

  async function sideAppPreview(body) {
    const { sessionId, target } = await authorizeFile(body, { app: 'canvas' })
    const info = await statTarget(target.realPath)
    if (info.size > HTML_LIMIT) return { kind: 'preview-unavailable', reason: 'The HTML file is larger than 8 MiB' }
    // One live ticket per file and session: a repeat call refreshes it instead of
    // multiplying routes, and a renamed entry gets a fresh one.
    let ticket = [...tickets.values()].find(item => item.entryReal === target.realPath && item.sessionId === sessionId)
    if (ticket !== undefined) ticket = renewTicket(ticket.id, sessionId)
    // A ticket that lapsed while the client polled is dead: reissue rather than renew,
    // so the answer always carries a live frameUrl, never an unchanged dead address.
    const fresh = ticket === undefined
    if (ticket === undefined) ticket = issueTicket({ entryReal: target.realPath, displayPath: target.displayPath, sessionId })
    const { revision, truncated } = await previewRevision(ticket)
    // A fresh ticket never answers `unchanged`: its frame URL differs from the one the
    // client holds, and unchanged bytes on a dead address would leave the preview dark.
    if (!fresh && typeof body.knownPreviewRevision === 'string' && body.knownPreviewRevision === revision) {
      return { kind: 'unchanged', previewRevision: revision, frameUrl: frameUrl(ticket), expiresAt: ticket.expiresAt }
    }
    return { kind: 'preview', frameUrl: frameUrl(ticket), expiresAt: ticket.expiresAt, previewRevision: revision, ...(truncated ? { manifestTruncated: true } : {}) }
  }

  // ---- the open tools -----------------------------------------------------------
  /** @type {Map<string, {openId:string, app:string, sessionId:string, descriptor:object, at:number}>} */
  const pendingOpens = new Map()
  const sweepOpens = (now = Date.now()) => {
    for (const [id, open] of pendingOpens) if (now - open.at > OPEN_KEEP_MS) pendingOpens.delete(id)
  }

  async function sideAppOpened(body) {
    const openId = String(body?.openId ?? '')
    const open = pendingOpens.get(openId)
    if (open === undefined) return { consumed: false }
    pendingOpens.delete(openId)
    return { consumed: true }
  }

  const cleanTab = (value) => {
    const tab = typeof value === 'string' ? value : ''
    if (tab === '') return undefined
    if (!['preview', 'source', 'diff'].includes(tab)) throw invalid('tab must be preview, source or diff')
    return tab
  }

  async function openTool(app, args, exec) {
    await rt.load()
    const id = exec.agent?.id
    const label = app === 'canvas' ? 'canvas' : 'reader'
    if (rt.taskOwners?.has(id)) return `Background tasks cannot open a ${label} panel. Open it from your own chat instead.`
    const owner = rt.groupOwners.get(id)
    if (owner !== undefined && !rt.roomHasImOrigin?.(owner.roomId)) return `A ${label} panel only opens from your own chat with the user. In a group, tell the user the path instead.`
    if (owner === undefined && !rt.chatOwners.has(id)) return `Only Bots on the team can open a ${label} panel.`
    const session = exec.agent?.session
    const root = await workRootOf(session)
    if (root === undefined) return 'This conversation has no working folder yet, so no file can be opened. Send a normal message first.'
    const raw = typeof args.path === 'string' ? args.path.trim() : ''
    if (raw === '') return 'Give the path of the file to open.'
    let tab
    try {
      tab = cleanTab(args.tab)
    } catch (error) {
      return error.message
    }
    let target
    try {
      target = await resolveInRoot(root, raw)
      fileKind(app, target.realPath)
      const info = await statTarget(target.realPath)
      if (app === 'canvas' && info.size > HTML_LIMIT) return `That HTML file is ${(info.size / (1024 * 1024)).toFixed(1)} MiB, larger than the 8 MiB Canvas limit. Open it in an editor instead.`
    } catch (error) {
      return `Could not open the file: ${error.message}`
    }
    const descriptor = {
      v: 1,
      app,
      sessionId: id,
      workspaceTag: rootTag(target.root),
      displayPath: target.displayPath,
      ...(tab !== undefined ? { tab } : {}),
    }
    sweepOpens()
    const openId = randomUUID()
    pendingOpens.set(openId, { openId, app, sessionId: id, descriptor, at: Date.now() })
    rt.cardShown?.(id, app, target.displayPath)
    const name = app === 'canvas' ? 'Canvas' : 'Reader'
    return [
      JSON.stringify(descriptor),
      `${name} opened for ${target.displayPath}. The card in this chat reopens it; the view refreshes by itself when the file changes.`,
    ].join('\n')
  }

  rt.teamTools.push(defineTool({
    name: 'open_canvas',
    description: 'Open a workspace HTML file (.html/.htm) in the Canvas panel beside your chat: the user sees an interactive sandboxed preview that refreshes as you write or edit the file, plus read-only source and diff views. The card this leaves in the chat reopens the same file. Use it when you draft or iterate on a front-end prototype or HTML artifact; keep editing the file with write/edit as usual. Only your own chat with the user can open it.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path of the HTML file in your working folder; a relative path starts there' },
      tab: { type: 'string', enum: ['preview', 'source', 'diff'], description: 'Which Canvas view to show first; default preview. "diff" only when the file was just edited in this conversation' },
    },
    output,
    execute: (args, exec) => openTool('canvas', args, exec),
  }))

  rt.teamTools.push(defineTool({
    name: 'open_reader',
    description: 'Open a workspace Markdown file (.md/.markdown/.mdx) in the Reader panel beside your chat: comfortable long-form reading with an outline, read-only source, a diff view of your edits, and a way for the user to select a passage and send you a targeted revision instruction. The card this leaves in the chat reopens the same file. Use it for long articles, specs or drafts the user should review; keep editing with write/edit as usual. Only your own chat with the user can open it.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path of the Markdown file in your working folder; a relative path starts there' },
      tab: { type: 'string', enum: ['preview', 'source', 'diff'], description: 'Which Reader view to show first; default preview (rendered reading). "diff" only when the file was just edited in this conversation' },
    },
    output,
    execute: (args, exec) => openTool('reader', args, exec),
  }))

  // What the state answer carries for a window: opens nobody consumed yet, keyed by
  // the Session they belong to. The window claims one with `side-app-opened`.
  const sideAppOpensView = () => {
    sweepOpens()
    const view = {}
    for (const open of pendingOpens.values()) {
      view[open.sessionId] = { openId: open.openId, ...open.descriptor }
    }
    return view
  }

  async function sideAppEndpoint(endpoint, body) {
    switch (endpoint) {
      case 'side-app-open': return sideAppOpen(body)
      case 'side-app-read': return sideAppRead(body)
      case 'side-app-diff': return sideAppDiff(body)
      case 'side-app-preview': return sideAppPreview(body)
      case 'side-app-opened': return sideAppOpened(body)
      case 'side-app-bytes': return sideAppBytes(body)
      default: throw Object.assign(new Error(`Unknown endpoint ${endpoint}`), { code: 'bot/not-found' })
    }
  }

  ctx.effect(() => () => {
    tickets.clear()
    pendingOpens.clear()
    diffBases.clear()
  }, 'ds-bot: side apps')

  Object.assign(rt, { sideAppEndpoint, sideAppOpensView })
  // Internals the tests probe without going through a window.
  Object.assign(rt, {
    sideAppInternals: {
      workRootOf,
      resolveInRoot,
      rootTag,
      issueTicket,
      renewTicket,
      previewRevision,
      serveAsset,
      frameUrl,
      isUtf8,
      diffBases,
      tickets,
      pendingOpens,
      writePair,
      TEXT_LIMIT,
      HTML_LIMIT,
      CANVAS_ROUTE,
    },
  })
}
