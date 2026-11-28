// Side Apps: the host half of the Canvas and Reader workbench (design:
// docs/plans/2026-11-25-side-app-workbench.md). The `open_canvas` and `open_reader`
// team tools validate a workspace file and leave a reopenable card; the `/api/bot`
// endpoints authorize every open/read/diff/preview again against the Session's own
// working root; and a ticketed web-server route serves a Canvas entry document and
// its same-directory assets to the sandboxed preview iframe.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, open, readdir, readlink, stat } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'
import { within } from './folders.js'
import { threadCurrentOfPart, threadOfPart } from './threads.js'

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
// Dot segments count by the real path, not by the spelling the request used: a plain-looking
// link into a hidden directory is still hidden. Sensitive names carry their own proof.
const hiddenOrSensitive = (root, real) => relative(root, real).split(/[\\/]+/).some(part => part.startsWith('.')) || SENSITIVE_NAME.test(real)

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

  // Reads stat and bytes through one open handle: what the checks approved is what
  // the caller gets, even if the path is swapped in between. Size and kind come from
  // the handle's own fstat, never from a separate look at the path. The read itself
  // is bounded: at most ceiling+1 bytes are ever buffered — one extra byte proves
  // overflow, and a file growing after fstat never lands whole in memory.
  const READ_HARD_CAP = 16 * 1024 * 1024
  async function readBounded(handle, ceiling) {
    const chunks = []
    let total = 0
    const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, ceiling + 1))
    for (;;) {
      const room = ceiling + 1 - total
      if (room <= 0) break
      const { bytesRead } = await handle.read(scratch, 0, Math.min(scratch.length, room), null)
      if (bytesRead === 0) break
      // The scratch is reused by the next read, so every chunk copies out of it:
      // a shared view would see the bytes of a later read instead of its own.
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)))
      total += bytesRead
    }
    return Buffer.concat(chunks, total)
  }

  // ---- verified open: binding authorization to the object that is read -----------
  //
  // The threat is a path swap between the path-level authorization (realpath
  // folding, containment, inData) and the open syscall that actually chooses the
  // object. Neither Node nor the documented DSH APIs expose openat2(RESOLVE_BENEATH)
  // or dirfd-relative opens, so the binding is proven after opening instead:
  //
  // 1. Linux with /proc: `readlink /proc/self/fd/<n>` names the opened object itself,
  //    independent of any path manipulation in progress. That object path is folded
  //    and re-proved against the anchor and the data roots — the strong proof.
  // 2. Everywhere: the opened object's (dev, ino) must equal those of the path the
  //    authorization describes, where that path is re-folded and re-proved at the
  //    moment of opening. A swap between the fold and the probe changes the identity
  //    the probe sees, so the comparison fails closed; a swap before both either
  //    keeps the authorized object (no escape) or fails the containment/inData proof.
  //    The residual is a double race hitting the nanosecond gaps around the fold —
  //    documented in the plan, not claimed closed.
  //
  // bigint stats are mandatory: Windows NTFS file indices exceed Number.MAX_SAFE_INTEGER,
  // and a precision-collapsed comparison is no comparison at all. On filesystems that
  // report no usable identity (ino 0 — some FAT/SMB shares) verification refuses
  // closed: the Canvas never silently falls back to path-only trust.
  const identityOf = info => (info !== undefined && info.ino !== 0n ? { dev: info.dev, ino: info.ino } : undefined)

  async function verifyOpened(handle, realPath, { anchor } = {}) {
    const own = await handle.stat({ bigint: true })
    if (!own.isFile()) throw invalid('That path is not a file')
    const ownIdentity = identityOf(own)
    if (ownIdentity === undefined) {
      throw forbidden('This filesystem gives no reliable file identity, so the file cannot be bound to its authorization')
    }

    // The strong proof: where /proc names objects, the opened object itself is
    // containment- and data-root-proven, whatever state the original path is in.
    // A deleted or unresolvable object path fails this branch only — the identity
    // comparison below still carries the binding on its own.
    if (process.platform === 'linux') {
      try {
        const objectPath = await readlink(`/proc/self/fd/${handle.fd}`)
        const objectReal = (await rt.realBeyond?.(objectPath).catch(() => undefined)) ?? (await rt.real?.(objectPath).catch(() => undefined)) ?? objectPath
        if (!within(objectReal, anchor)) throw forbidden('That path leaves the working folder')
        if (await rt.inData?.(objectReal)) throw forbidden('That path is inside DeepSeek Harness or team data, which cannot be opened here')
      } catch (error) {
        if (error?.code === 'bot/forbidden') throw error
        // No /proc (unusual mounts, sandboxed runtimes): the identity comparison below carries alone.
      }
    }

    // The portable proof, always required: the object that was opened must be the
    // object the authorized path names right now, and that naming must still prove
    // the containment and data-root rules. A path swapped out from under the open
    // can satisfy at most one side of the pair.
    const folded = (await rt.realBeyond?.(realPath).catch(() => undefined)) ?? (await rt.real?.(realPath).catch(() => undefined)) ?? undefined
    if (folded === undefined || !within(folded, anchor)) throw forbidden('That path leaves the working folder')
    if (await rt.inData?.(folded)) throw forbidden('That path is inside DeepSeek Harness or team data, which cannot be opened here')
    const probe = await lstat(folded, { bigint: true }).catch(() => undefined)
    const probeIdentity = probe !== undefined && probe.isFile() ? identityOf(probe) : undefined
    if (probeIdentity === undefined || probeIdentity.dev !== ownIdentity.dev || probeIdentity.ino !== ownIdentity.ino) {
      // The path no longer names the object the open captured: nothing proves this
      // read reads what the authorization approved.
      throw forbidden('The file changed while it was being opened; read it again')
    }
    return own
  }

  // The one read path of the whole module: every byte the host serves or scans comes
  // through here. `anchor` is the containment boundary the read must prove at read
  // time — the session's working root, or the ticket's entry directory for the
  // preview route and scan — never merely a promise made before the path could change.
  async function readVerified(realPath, { anchor, limit, oversized } = {}) {
    if (anchor === undefined) throw invalid('A verified read needs its containment anchor')
    let handle
    try {
      handle = await open(realPath, 'r')
    } catch {
      throw notFound('The file is no longer there')
    }
    try {
      const info = await verifyOpened(handle, realPath, { anchor })
      const ceiling = limit !== undefined ? Math.min(limit, READ_HARD_CAP) : READ_HARD_CAP
      if (info.size > ceiling) throw tooLarge(oversized ?? 'The file is too large')
      const bytes = await readBounded(handle, ceiling)
      if (bytes.length > ceiling) throw tooLarge(oversized ?? 'The file is too large')
      return { bytes, size: Number(info.size) }
    } finally {
      await handle.close().catch(() => {})
    }
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

  const fileKind = (app, realPath, root) => {
    const ext = extname(realPath).toLowerCase()
    if (app === 'canvas') {
      // Dot segments anywhere below the working root count, not only the file's own
      // name: an entry inside `.hidden/` would otherwise make that directory the
      // ticket root, where the asset scan can no longer see the dot.
      if (root !== undefined ? hiddenOrSensitive(root, realPath) : basename(realPath).startsWith('.') || SENSITIVE_NAME.test(realPath)) throw forbidden('Canvas does not open hidden or credential files')
      if (!CANVAS_EXTENSIONS.has(ext)) throw invalid(`Canvas opens HTML files (.html/.htm), not ${ext || 'this file'}`)
    } else if (!READER_EXTENSIONS.has(ext)) throw invalid(`Reader opens Markdown files (.md/.markdown/.mdx), not ${ext || 'this file'}`)
    return ext
  }

  // ---- diff bases -------------------------------------------------------------
  // The before/after text a `ctx.fs` write hands its caller, captured as the write's
  // tool result passes. Bases are keyed by session and file: one conversation's
  // write chain never merges with another's view of the same path. Per file the
  // first before and the last after of a turn form one base, and only a chain
  // whose versions actually connect may merge — shell redirection and outside
  // editors never produce one, which the plan accepts as the client-snapshot case.
  /** @type {Map<string, {realPath:string, before:string, after:string, baseRevision:string, afterRevision:string, turn?:number, sessionId:string, at:number}>} */
  const diffBases = new Map()
  const diffKey = (sessionId, realPath) => `${sessionId}\0${foldKey(realPath)}`

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
    const sessionId = agentId ?? session.id
    const key = diffKey(sessionId, target.realPath)
    const turn = rt.live?.get(agentId)?.turn
    const entry = {
      realPath: target.realPath,
      before: pair.before,
      after: pair.after,
      baseRevision: sha(Buffer.from(pair.before, 'utf8')),
      afterRevision: sha(Buffer.from(pair.after, 'utf8')),
      ...(Number.isInteger(turn) ? { turn } : {}),
      sessionId,
      at: Date.now(),
    }
    const earlier = diffBases.get(key)
    if (
      earlier !== undefined
      && earlier.turn !== undefined && earlier.turn === entry.turn
      && earlier.sessionId === entry.sessionId
      && Date.now() - earlier.at <= DIFF_KEEP_MS
      && sha(Buffer.from(pair.before, 'utf8')) === earlier.afterRevision
    ) {
      // Several writes in one turn diff from the first before to the last after —
      // but only while the chain of versions actually connects and the turn is known.
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
  /** @type {Map<string, {id:string, entryReal:string, entryName:string, root:string, displayPath:string, sessionId:string, ownerBot?:string, createdAt:number, expiresAt:number}>} */
  const tickets = new Map()

  const sweepTickets = (now = Date.now()) => {
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id)
  }

  function issueTicket({ entryReal, displayPath, sessionId, ownerBot }) {
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
      ...(ownerBot !== undefined ? { ownerBot } : {}),
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
    // The entry is part of the scan's own authorization: gone, mutated into a
    // non-file, sitting inside harness or team data, or grown past the serving
    // limit makes the scan fail, never a hash of oversized bytes read wholesale.
    if (await rt.inData?.(ticket.entryReal)) throw forbidden('That path is inside DeepSeek Harness or team data, which cannot be opened here')
    const entryRead = await readVerified(ticket.entryReal, { anchor: ticket.root, limit: HTML_LIMIT, oversized: 'The HTML file is larger than 8 MiB' }).catch(error => error)
    if (entryRead instanceof Error) throw entryRead
    hash.update(entryRead.bytes)
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
        if (hiddenOrSensitive(ticket.root, real)) continue
        if ((await rt.privateOwnerOf?.(real, { self: ticket.ownerBot })) !== undefined) continue
        if (entry.isDirectory()) {
          await walk(real, depth + 1)
          continue
        }
        if (!entry.isFile() || real === ticket.entryReal) continue
        const ext = extname(entry.name).toLowerCase()
        if (!ASSET_MIMES.has(ext) || SENSITIVE_NAME.test(real)) continue
        if (await rt.inData?.(real)) continue
        const info = await stat(real).catch(() => undefined)
        if (info === undefined || !info.isFile() || info.size > ASSET_LIMIT) continue
        counted += 1
        if (counted > MANIFEST_FILES_MAX) {
          truncated = true
          continue
        }
        hash.update('\0file\0')
        hash.update(real.slice(ticket.root.length))
        hash.update(String(info.size))
        hash.update(String(Math.floor(info.mtimeMs)))
        if (info.size <= MANIFEST_BYTES_MAX) hash.update((await readVerified(real, { anchor: ticket.root, limit: MANIFEST_BYTES_MAX }).catch(() => ({ bytes: Buffer.alloc(0) }))).bytes)
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
    if (await rt.inData?.(real)) return errorPage(404, 'Not found')
    if (!within(real, ticket.root)) return errorPage(404, 'Not found')
    if (rel.split('/').some(part => part === '..' || part === '.' || part.startsWith('.'))) return errorPage(404, 'Not found')
    if (hiddenOrSensitive(ticket.root, real)) return errorPage(404, 'Not found')
    if ((await rt.privateOwnerOf?.(real, { self: ticket.ownerBot })) !== undefined) return errorPage(404, 'Not found')
    const ext = extname(real).toLowerCase()
    const mime = ASSET_MIMES.get(ext)
    if (mime === undefined) return errorPage(404, 'Not found')
    const limit = ext === '.html' || ext === '.htm' ? HTML_LIMIT : ASSET_LIMIT
    // Checks and bytes go through one open handle: the file the path checks approved
    // is the file that is served, even if the path is swapped in between.
    let bytes
    try {
      bytes = (await readVerified(real, { anchor: ticket.root, limit, oversized: 'too large' })).bytes
    } catch (error) {
      return errorPage(error?.code === 'bot/too-large' ? 413 : 404, error?.code === 'bot/too-large' ? 'Too large' : 'Not found')
    }
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
    if (
      rt.roomOf(sessionId) !== undefined || rt.groupOwners.has(sessionId) || past?.roomId !== undefined
      || rt.taskOwners?.has(sessionId) || ownerBot === undefined
    ) throw notFound('Unknown session')
    // An earlier part of the Bot's own chat reopens through the part that thread has
    // now; the archived part itself may be gone and its cwd may be stale. Task parts
    // never widen into the foreground chat.
    let authorizingSession = sessionId
    if (past !== undefined) {
      const bot = rt.botOf?.(past.botId)
      if (threadOfPart(bot, sessionId)?.thread === 'task') throw notFound('Unknown session')
      authorizingSession = threadCurrentOfPart(bot, sessionId) ?? rt.chatOf?.(past.botId)
    }
    if (authorizingSession === undefined) throw notFound('The conversation that wrote this card is no longer here; open the file again from the current chat')
    const agent = await rt.resolveAgent(authorizingSession).catch(() => undefined)
    if (agent?.session === undefined) throw notFound('The conversation that wrote this card is no longer here; open the file again from the current chat')
    const root = await workRootOf(agent.session)
    if (root === undefined) throw invalid('This conversation has no working folder here')
    if (typeof file.workspaceTag !== 'string' || file.workspaceTag !== rootTag(root)) {
      throw workspaceChanged('The working folder changed since this card was written; open the file again')
    }
    if (app !== undefined && file.app !== app) throw invalid('That card belongs to another app')
    if (typeof file.displayPath !== 'string' || file.displayPath === '') throw invalid('No file named')
    const target = await resolveInRoot(root, file.displayPath)
    if ((await rt.privateOwnerOf?.(target.realPath, { self: ownerBot })) !== undefined) {
      throw forbidden('That file belongs to a private Bot and cannot be opened here')
    }
    return { sessionId, target, root, agent, app: file.app, ownerBot }
  }

  // ---- endpoints ---------------------------------------------------------------

  async function sideAppOpen(body) {
    const app = body?.app === 'canvas' || body?.app === 'reader' ? body.app : undefined
    if (app === undefined) throw invalid('app must be canvas or reader')
    const { target } = await authorizeFile(body, { app })
    const ext = fileKind(app, target.realPath, target.root)
    const limits = app === 'canvas' ? { limit: HTML_LIMIT, oversized: 'The HTML file is larger than 8 MiB' } : {}
    const { bytes, size } = await readVerified(target.realPath, { anchor: target.root, ...limits })
    const revision = sha(bytes)
    return {
      file: { app, displayPath: target.displayPath, workspaceTag: rootTag(target.root) },
      revision,
      size,
      previewAvailable: app === 'canvas' && size <= HTML_LIMIT,
      textLimited: size > TEXT_LIMIT,
      extension: ext,
    }
  }

  async function sideAppRead(body) {
    const { target, app } = await authorizeFile(body)
    // The card's app binds what may be read: a canvas card never reads Markdown and a
    // reader card never reads HTML, however the caller rewrites displayPath.
    fileKind(app, target.realPath, target.root)
    // Text reads cap at the text line even for HTML: the 8 MiB allowance is for the
    // rendered preview bytes, never for text a client shows.
    const { bytes } = await readVerified(target.realPath, { anchor: target.root, limit: TEXT_LIMIT, oversized: 'The file is larger than 4 MiB of text' })
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
    // The article the image binds to must be a real regular file, not a path that
    // merely names one: a symlinked directory or a missing file never anchors bytes.
    await statTarget(document.realPath)
    const ext = extname(target.realPath).toLowerCase()
    const mime = IMAGE_MIMES.get(ext)
    if (mime === undefined) throw invalid(`Only image files can be read here (png, jpg, gif, webp, avif, svg), not ${ext || 'this file'}`)
    // The read-time anchor matches the granularity resolveSiblingOf authorized: the
    // article's own folder, not the whole working root.
    const { bytes } = await readVerified(target.realPath, { anchor: dirname(document.realPath), limit: IMAGE_LIMIT, oversized: 'The image is larger than 4 MiB' })
    const revision = sha(bytes)
    if (typeof body.knownRevision === 'string' && body.knownRevision === revision) return { kind: 'unchanged', revision }
    return { kind: 'bytes', revision, mime, size: bytes.length, data: bytes.toString('base64') }
  }

  async function sideAppDiff(body) {
    const { sessionId, target } = await authorizeFile(body)
    const revision = typeof body.revision === 'string' ? body.revision : ''
    const entry = diffBases.get(diffKey(sessionId, target.realPath))
    // A base answers only the conversation whose writes produced it, while it is young:
    // another session editing the same file or an hour-old write is the client-snapshot case.
    if (
      entry === undefined || revision === '' || entry.afterRevision !== revision
      || entry.sessionId !== sessionId || Date.now() - entry.at > DIFF_KEEP_MS
    ) return { kind: 'unavailable' }
    return {
      kind: 'host',
      before: entry.before,
      after: entry.after,
      baseRevision: entry.baseRevision,
      revision: entry.afterRevision,
      ...(entry.turn !== undefined ? { turn: entry.turn } : {}),
    }
  }

  async function sideAppPreview(body) {
    const { sessionId, target, ownerBot } = await authorizeFile(body, { app: 'canvas' })
    // The preview entry revalidates as a real, regular HTML file every time: a card
    // cannot outlive its target turning into a directory, a symlink or another type.
    fileKind('canvas', target.realPath, target.root)
    const info = await statTarget(target.realPath)
    if (info.size > HTML_LIMIT) return { kind: 'preview-unavailable', reason: 'The HTML file is larger than 8 MiB' }
    // One live ticket per file and session: a repeat call refreshes it instead of
    // multiplying routes, and a renamed entry gets a fresh one.
    let ticket = [...tickets.values()].find(item => item.entryReal === target.realPath && item.sessionId === sessionId)
    if (ticket !== undefined) ticket = renewTicket(ticket.id, sessionId)
    // A ticket that lapsed while the client polled is dead: reissue rather than renew,
    // so the answer always carries a live frameUrl, never an unchanged dead address.
    const fresh = ticket === undefined
    if (ticket === undefined) ticket = issueTicket({ entryReal: target.realPath, displayPath: target.displayPath, sessionId, ownerBot })
    const scanned = await previewRevision(ticket).catch(error => error)
    if (scanned instanceof Error) return { kind: 'preview-unavailable', reason: 'The file could not be read; open it again when it is back' }
    const { revision, truncated } = scanned
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
    if (owner !== undefined) return `A ${label} panel only opens from your own chat with the user. In a group, tell the user the path instead.`
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
      fileKind(app, target.realPath, root)
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
      verifyOpened,
      readVerified,
      TEXT_LIMIT,
      HTML_LIMIT,
      CANVAS_ROUTE,
    },
  })
}
