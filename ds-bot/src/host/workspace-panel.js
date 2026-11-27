// Workspace right-panel backend for the desktop app: read-only workspace file tree,
// multi-format file preview (Markdown, code, text, CSV/TSV tables, images, PDF, HTML,
// and Office via libreoffice-kit), turn change diffs (`workspace-changes` via
// `ctx.workspaceChanges`), and interactive local terminals (`ctx.subprocess.spawnTerminal`
// with process-group stdio fallback).
// Computer-local only: phone and remote links refuse `workspace-*` and `terminal-*`
// (phone.js, remote.js), and terminal output rides local SSE only (`publishLocalFeed`).
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, open, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { within } from './folders.js'

const MAX_LIST_ENTRIES = 500
const PARALLEL_LIST_INSPECTS = 8
const MAX_TEXT_BYTES = 512 * 1024
const MAX_BINARY_BYTES = 16 * 1024 * 1024
const MAX_OFFICE_INPUT_BYTES = 32 * 1024 * 1024
const MAX_OFFICE_OUTPUT_BYTES = 24 * 1024 * 1024
const MAX_OFFICE_CONVERSIONS = 2
const MAX_TERMINALS = 8
const TERMINAL_SCROLLBACK_CHARS = 64 * 1024
const TERMINAL_SCROLLBACK_PART_CHARS = 4096
const TERMINAL_BATCH_MS = 16
const TERMINAL_GRACE_MS = 3000
const DIFF_TIMEOUT_MS = 30_000

const DEFAULT_IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])
const SENSITIVE_ENV_RE = /KEY|PASSWORD|SECRET|TOKEN/i
const STRIPPED_ENV_RE = /^(DS_BOT_|DSBOT_|DSH_|ELECTRON_RUN_AS_NODE$|ACP_BACKEND$|DEEPSEEK_|ANTIGRAVITY_|AGY_)/i

const IMAGE_MIMES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
])

const OFFICE_EXTS = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.rtf'])
const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown'])
const HTML_EXTS = new Set(['.html', '.htm'])
const TABLE_DELIMITERS = new Map([['.csv', ','], ['.tsv', '\t']])

const CODE_LANGUAGES = new Map([
  ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'], ['.jsx', 'jsx'],
  ['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'], ['.tsx', 'tsx'],
  ['.json', 'json'], ['.jsonc', 'json'], ['.jsonl', 'json'],
  ['.css', 'css'], ['.scss', 'scss'], ['.less', 'less'],
  ['.yml', 'yaml'], ['.yaml', 'yaml'], ['.toml', 'toml'], ['.xml', 'xml'], ['.svg', 'xml'],
  ['.py', 'python'], ['.rb', 'ruby'], ['.go', 'go'], ['.rs', 'rust'], ['.java', 'java'],
  ['.kt', 'kotlin'], ['.swift', 'swift'], ['.c', 'c'], ['.h', 'c'], ['.cpp', 'cpp'], ['.hpp', 'cpp'],
  ['.cs', 'csharp'], ['.php', 'php'], ['.sh', 'bash'], ['.zsh', 'bash'], ['.bash', 'bash'],
  ['.ps1', 'powershell'], ['.sql', 'sql'], ['.graphql', 'graphql'], ['.gql', 'graphql'],
  ['.dockerfile', 'dockerfile'], ['.env', 'dotenv'], ['.ini', 'ini'], ['.conf', 'ini'],
])

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const notFound = message => Object.assign(new Error(message), { code: 'bot/not-found' })
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })

const withinRoot = (inner, outer) => (process.platform === 'win32'
  ? within(inner.toLowerCase(), outer.toLowerCase())
  : within(inner, outer))

const toPosixRel = (root, target) => {
  const rel = relative(root, target)
  if (!rel || rel === '.') return ''
  return sep === '/' ? rel : rel.split(sep).join('/')
}

async function readBoundedBytes(filePath, maxBytes) {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(maxBytes + 1)
    let total = 0
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total)
      if (bytesRead <= 0) break
      total += bytesRead
    }
    const truncated = total > maxBytes
    return { bytes: buf.subarray(0, truncated ? maxBytes : total), truncated }
  } finally {
    await handle.close()
  }
}

function hasNullByte(bytes) {
  const probe = bytes.subarray(0, Math.min(bytes.length, 8192))
  return probe.includes(0)
}

function defaultShell() {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec?.trim()
    return [comspec || 'powershell.exe']
  }
  const sh = process.env.SHELL?.trim()
  if (sh && isAbsolute(sh)) return [sh, '-l']
  return ['/bin/sh']
}

// Explicit env layer for `ctx.subprocess.spawnTerminal`: lets DSH's `scrubbedParentEnv()`
// strip credentials and forward proxy settings, then adds `undefined` tombstones for
// DS Bot / Electron / agent harness prefixes that `scrubbedParentEnv()` does not strip.
function ptyEnvOverrides() {
  const overrides = { COLORTERM: 'truecolor' }
  for (const key of Object.keys(process.env)) {
    if (STRIPPED_ENV_RE.test(key)) overrides[key] = undefined
  }
  return overrides
}

// Full scrubbed env for the `child_process.spawn` fallback when `ctx.subprocess` is absent.
function fallbackTerminalEnv() {
  const out = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    if (SENSITIVE_ENV_RE.test(key) || STRIPPED_ENV_RE.test(key)) continue
    out[key] = value
  }
  out.TERM = 'xterm-256color'
  out.COLORTERM = 'truecolor'
  return out
}

function clampDim(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

let activeOfficeConversions = 0

async function convertOfficeToPdf(inputRealPath, ext, signal) {
  if (signal?.aborted) throw Object.assign(new Error('Conversion cancelled'), { code: 'bot/aborted' })
  if (activeOfficeConversions >= MAX_OFFICE_CONVERSIONS) {
    return { status: 'unavailable', error: 'Office preview is busy' }
  }
  let kit
  try {
    kit = await import('@deepseek-ai/libreoffice-kit')
  } catch {
    return { status: 'unavailable' }
  }
  if (typeof kit?.createConverter !== 'function') return { status: 'unavailable' }
  activeOfficeConversions += 1
  let workDir = null
  let converter = null
  try {
    if (signal?.aborted) throw Object.assign(new Error('Conversion cancelled'), { code: 'bot/aborted' })
    workDir = await mkdtemp(join(tmpdir(), 'dsb-office-'))
    const stagedInput = join(workDir, `source${ext}`)
    const outputPdf = join(workDir, 'preview.pdf')
    await copyFile(inputRealPath, stagedInput)
    if (signal?.aborted) throw Object.assign(new Error('Conversion cancelled'), { code: 'bot/aborted' })
    converter = await kit.createConverter({
      timeoutMs: 45_000,
      maxInputBytes: MAX_OFFICE_INPUT_BYTES,
      maxOutputBytes: MAX_OFFICE_OUTPUT_BYTES,
    })
    await converter.render({ inputPath: stagedInput, outputPath: outputPdf }, signal)
    const info = await stat(outputPdf)
    if (info.size > MAX_OFFICE_OUTPUT_BYTES) {
      return { status: 'too-large', size: info.size, maxBytes: MAX_OFFICE_OUTPUT_BYTES }
    }
    const { bytes, truncated } = await readBoundedBytes(outputPdf, MAX_OFFICE_OUTPUT_BYTES)
    if (truncated) return { status: 'too-large', size: info.size, maxBytes: MAX_OFFICE_OUTPUT_BYTES }
    return { status: 'ok', bytes }
  } finally {
    activeOfficeConversions = Math.max(0, activeOfficeConversions - 1)
    await converter?.dispose?.().catch(() => {})
    if (workDir !== null) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, { id: string, cwd: string, title: string, pty: boolean, exited: boolean, closed: boolean, exitCode: number | null, buffer: string, parts: { seq: number, text: string }[], startSeq: number, endSeq: number, write: (data: string) => Promise<void>, resize: (cols: number, rows: number) => Promise<void>, terminate: () => Promise<void> }>} */
  const terminals = new Map()
  /** @type {Set<Promise<void>>} */
  const inFlightSpawns = new Set()
  let reservedSlots = 0
  let disposed = false

  const emitLocal = (event, data) => {
    if (typeof rt.publishLocalFeed === 'function') rt.publishLocalFeed(event, data)
    else rt.publishFeed?.(event, data)
  }

  // Mirror folders.js's team-workspace exception strictly when `defaultTeamFolder()` is used
  // before `ensureWorkspace()` registers `state.workspaceId`: only a default workspace lying
  // strictly inside a data root is exempted; an ancestor containing a data root never opens it up.
  const isProtectedData = async (target) => {
    if (!(await rt.inData(target))) return false
    if (rt.teamFolder() !== undefined) return true
    const defaultWs = await rt.real(resolve(rt.defaultTeamFolder()))
    if (!withinRoot(target, defaultWs)) return true
    for (const root of [rt.dshHome, rt.home, process.env.DS_BOT_USER_DSH_HOME?.trim()].filter(Boolean)) {
      const data = await rt.real(root)
      if (withinRoot(target, data) && !(defaultWs !== data && withinRoot(defaultWs, data))) return true
    }
    return false
  }

  const resolveWorkspaceRoot = async (sessionId) => {
    await rt.load()
    let raw
    if (typeof sessionId === 'string' && sessionId !== '') {
      // Prefer the live session's active working directory (honors `working_directory` subfolder moves).
      const live = ctx.sessions?.get?.(sessionId)
      if (live !== undefined) raw = rt.sessionFolder?.(live)
      if (raw === undefined) {
        const room = rt.roomOf(sessionId)
        if (room !== undefined) {
          raw = rt.workDirOf({ roomId: room.id }) ?? rt.teamFolder()
        } else {
          // Check room-scoped owners before `selfOf` so non-live group/task sessions keep `roomId`.
          const owner = rt.groupOwners?.get(sessionId) ?? rt.taskOwners?.get(sessionId) ?? rt.pastOwners?.get(sessionId)
          if (owner?.roomId !== undefined || owner?.botId !== undefined) {
            raw = rt.workDirOf({ roomId: owner.roomId, botId: owner.botId ?? rt.selfOf?.(sessionId) }) ?? rt.teamFolder()
          } else {
            const selfBotId = rt.selfOf?.(sessionId)
            if (selfBotId !== undefined) {
              raw = rt.workDirOf({ botId: selfBotId }) ?? rt.teamFolder()
            } else {
              const bot = rt.botOf(sessionId)
              if (bot !== undefined) raw = rt.workDirOf({ botId: bot.id }) ?? rt.teamFolder()
            }
          }
        }
      }
    }
    const base = raw ?? rt.teamFolder() ?? resolve(rt.defaultTeamFolder())
    const realRoot = await rt.real(base)
    if (await isProtectedData(realRoot)) throw refused('Workspace folder is inside protected data')
    if (!(await rt.isFolder(realRoot))) throw notFound('Workspace folder does not exist')
    return realRoot
  }

  const resolveSafeTarget = async (realRoot, inputPath = '') => {
    const raw = typeof inputPath === 'string' ? inputPath : ''
    if (raw.includes('\0')) throw invalid('Invalid file path')
    const candidate = raw === '' ? realRoot : (isAbsolute(raw) ? resolve(raw) : resolve(realRoot, raw))
    let realTarget
    try {
      realTarget = await realpath(candidate)
    } catch {
      const beyond = await (rt.realBeyond ? rt.realBeyond(candidate) : rt.real(candidate))
      if (!withinRoot(beyond, realRoot) || await isProtectedData(beyond)) {
        throw refused('Path is outside the active workspace')
      }
      throw notFound('File or folder not found')
    }
    if (!withinRoot(realTarget, realRoot) || await isProtectedData(realTarget)) {
      throw refused('Path is outside the active workspace')
    }
    return realTarget
  }

  // One listing row for a folder entry, or undefined when the entry is gone, escapes the
  // workspace, is protected data, is neither a file nor a folder, or is a folder symlink.
  const listEntry = async (realRoot, dirPath, entry) => {
    const full = join(dirPath, entry.name)
    let realEntry
    try {
      realEntry = await realpath(full)
    } catch {
      return undefined
    }
    if (!withinRoot(realEntry, realRoot) || await isProtectedData(realEntry)) return undefined
    let info
    try {
      info = await stat(realEntry)
    } catch {
      return undefined
    }
    const kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
    if (kind === null) return undefined
    // Skip directory symlinks to prevent cyclic trees and duplicate branch identities.
    if (entry.isSymbolicLink() && kind === 'dir') return undefined
    return {
      name: entry.name,
      path: toPosixRel(realRoot, full),
      kind,
      size: kind === 'file' ? info.size : 0,
      mtimeMs: Math.round(info.mtimeMs),
      ext: kind === 'file' ? extname(entry.name).toLowerCase() : '',
    }
  }

  async function workspaceEndpoint(name, body = {}, signal) {
    if (name === 'changes') return changesDetail(body, signal)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    let realRoot
    try {
      realRoot = await resolveWorkspaceRoot(sessionId)
    } catch (error) {
      if (name === 'list' && (body.path ?? '') === '' && error?.code === 'bot/not-found') {
        const fallback = rt.teamFolder() ?? resolve(rt.defaultTeamFolder())
        return { root: fallback, rootName: basename(fallback) || fallback, path: '', entries: [], truncated: false, missing: true }
      }
      throw error
    }

    if (typeof body.expectedRoot === 'string' && body.expectedRoot !== '') {
      const expected = await rt.real(body.expectedRoot)
      if (expected !== realRoot) {
        throw Object.assign(new Error('Workspace folder changed'), { code: 'bot/stale' })
      }
    }

    if (name === 'list') {
      const dirPath = await resolveSafeTarget(realRoot, body.path ?? '')
      const dirInfo = await stat(dirPath)
      if (!dirInfo.isDirectory()) throw invalid('Path is not a folder')
      const includeHidden = body.includeHidden === true
      const rawEntries = await readdir(dirPath, { withFileTypes: true })
      const visible = includeHidden
        ? rawEntries
        : rawEntries.filter(entry => !entry.name.startsWith('.') && !DEFAULT_IGNORED_NAMES.has(entry.name))
      // Inspected in parallel but kept in readdir order, so the stable sort breaks name ties as before.
      const inspected = Array.from({ length: visible.length })
      let next = 0
      const inspector = async () => {
        while (next < visible.length) {
          const at = next++
          inspected[at] = await listEntry(realRoot, dirPath, visible[at])
        }
      }
      await Promise.all(Array.from({ length: Math.min(PARALLEL_LIST_INSPECTS, visible.length) }, inspector))
      const items = inspected.filter(item => item !== undefined)
      let truncated = false
      items.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      if (items.length > MAX_LIST_ENTRIES) {
        items.length = MAX_LIST_ENTRIES
        truncated = true
      }
      return {
        root: realRoot,
        rootName: basename(realRoot) || realRoot,
        path: toPosixRel(realRoot, dirPath),
        entries: items,
        truncated,
      }
    }

    if (name === 'read') {
      if (typeof body.path !== 'string' || body.path === '') throw invalid('A file path is required')
      const target = await resolveSafeTarget(realRoot, body.path)
      const info = await stat(target)
      const fileName = basename(target) || basename(realRoot) || realRoot
      const relPath = toPosixRel(realRoot, target)
      if (info.isDirectory()) return { kind: 'dir', name: fileName, path: relPath, root: realRoot }
      if (!info.isFile()) throw invalid('Path is not a file')
      const ext = extname(fileName).toLowerCase()

      if (ext === '.pdf') {
        if (info.size > MAX_BINARY_BYTES) {
          return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_BINARY_BYTES }
        }
        const { bytes, truncated } = await readBoundedBytes(target, MAX_BINARY_BYTES)
        if (truncated) return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_BINARY_BYTES }
        return { kind: 'pdf', name: fileName, path: relPath, size: bytes.length, mime: 'application/pdf', base64: bytes.toString('base64') }
      }

      if (IMAGE_MIMES.has(ext) && ext !== '.svg') {
        if (info.size > MAX_BINARY_BYTES) {
          return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_BINARY_BYTES }
        }
        const { bytes, truncated } = await readBoundedBytes(target, MAX_BINARY_BYTES)
        if (truncated) return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_BINARY_BYTES }
        return { kind: 'image', name: fileName, path: relPath, size: bytes.length, mime: IMAGE_MIMES.get(ext), base64: bytes.toString('base64') }
      }

      if (OFFICE_EXTS.has(ext)) {
        if (info.size > MAX_OFFICE_INPUT_BYTES) {
          return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_OFFICE_INPUT_BYTES }
        }
        try {
          const converted = await convertOfficeToPdf(target, ext, signal)
          if (converted.status === 'ok') {
            return {
              kind: 'pdf',
              convertedFrom: ext,
              name: fileName,
              path: relPath,
              size: info.size,
              mime: 'application/pdf',
              base64: converted.bytes.toString('base64'),
            }
          }
          if (converted.status === 'too-large') {
            return { kind: 'too-large', convertedFrom: ext, name: fileName, path: relPath, size: converted.size, maxBytes: converted.maxBytes }
          }
          return { kind: 'office-unavailable', ext, name: fileName, path: relPath, size: info.size, ...(converted.error ? { error: converted.error } : {}) }
        } catch (error) {
          if (error?.code === 'bot/aborted') throw error
          return { kind: 'office-unavailable', ext, name: fileName, path: relPath, size: info.size, error: error?.message ?? String(error) }
        }
      }

      const { bytes, truncated } = await readBoundedBytes(target, MAX_TEXT_BYTES)
      if (hasNullByte(bytes)) {
        return { kind: 'binary', name: fileName, path: relPath, size: info.size, ext }
      }
      const text = bytes.toString('utf8')
      if (ext === '.svg') {
        const base64 = info.size <= MAX_BINARY_BYTES && !truncated ? bytes.toString('base64') : null
        return { kind: 'svg', name: fileName, path: relPath, size: info.size, text, truncated, base64, mime: 'image/svg+xml' }
      }
      if (MARKDOWN_EXTS.has(ext)) {
        return { kind: 'markdown', name: fileName, path: relPath, size: info.size, text, truncated }
      }
      if (HTML_EXTS.has(ext)) {
        return { kind: 'html', name: fileName, path: relPath, size: info.size, text, truncated }
      }
      if (TABLE_DELIMITERS.has(ext)) {
        return { kind: 'table', name: fileName, path: relPath, size: info.size, delimiter: TABLE_DELIMITERS.get(ext), text, truncated }
      }
      const language = CODE_LANGUAGES.get(ext) ?? (fileName.toLowerCase() === 'dockerfile' ? 'dockerfile' : fileName.toLowerCase() === 'makefile' ? 'makefile' : null)
      return {
        kind: language ? 'code' : 'text',
        language: language ?? 'text',
        name: fileName,
        path: relPath,
        size: info.size,
        text,
        truncated,
      }
    }

    throw notFound(`Unknown endpoint workspace-${name}`)
  }

  async function changesDetail(body = {}, signal) {
    const service = ctx.get?.('workspaceChanges')
    if (service === undefined) throw notFound('Change review is not available on this host')
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const seq = Number(body.seq)
    if (sessionId === '' || !Number.isInteger(seq)) throw invalid('Valid sessionId and seq are required')
    const summary = service.summary(sessionId, seq)
    if (summary === undefined) throw Object.assign(new Error('These changes are no longer available'), { code: 'bot/stale' })
    if (body.index === undefined) {
      return {
        sessionId,
        seq,
        turn: summary.turn,
        cwd: summary.cwd,
        total: summary.total,
        added: summary.added,
        deleted: summary.deleted,
        files: (summary.files ?? []).map((file, index) => ({
          index,
          path: file.path,
          display: file.display ?? file.path,
          added: file.added ?? 0,
          deleted: file.deleted ?? 0,
          ...(file.binary === true ? { binary: true } : {}),
          ...(file.oversized === true ? { oversized: true } : {}),
        })),
      }
    }
    const index = Number(body.index)
    if (!Number.isInteger(index) || index < 0) throw invalid('Valid file index is required')
    const diff = await service.diff(sessionId, seq, index, signal ?? AbortSignal.timeout(DIFF_TIMEOUT_MS))
    if (diff === undefined) throw Object.assign(new Error('This file diff is no longer available'), { code: 'bot/stale' })
    return diff
  }

  // Output positions count scrollback parts, not bytes: a client that holds part N asks
  // for N + 1, and trimming drops whole parts so the position never lands inside one.
  const appendScrollback = (term, chunk) => {
    if (!chunk) return
    let at = 0
    while (at < chunk.length) {
      let end = Math.min(at + TERMINAL_SCROLLBACK_PART_CHARS, chunk.length)
      const code = chunk.charCodeAt(end - 1)
      if (end < chunk.length && end > at + 1 && code >= 0xd800 && code <= 0xdbff) end -= 1
      const text = chunk.slice(at, end)
      term.endSeq += 1
      term.parts.push({ seq: term.endSeq, text })
      term.buffer += text
      at = end
    }
  }

  // Trim only between batches: output already collected for the next event keeps its
  // part metadata until that event has been emitted, so positions never rewrite a batch.
  const trimScrollback = (term) => {
    while (term.buffer.length > TERMINAL_SCROLLBACK_CHARS && term.parts.length > 1) {
      const first = term.parts.shift()
      term.buffer = term.buffer.slice(first.text.length)
    }
    term.startSeq = term.parts[0]?.seq ?? term.endSeq + 1
  }

  const readScrollback = (term, after = 0) => {
    if (!Number.isSafeInteger(after) || after < 0) throw invalid('after must be a non-negative whole number')
    const truncated = after + 1 < term.startSeq
    const from = Math.max(after, term.startSeq - 1)
    const parts = term.parts.filter(part => part.seq > from).map(part => ({ seq: part.seq, text: part.text }))
    return {
      id: term.id,
      start: term.startSeq,
      end: term.endSeq,
      truncated,
      parts,
      chunk: parts.map(part => part.text).join(''),
      exited: term.exited,
      exitCode: term.exitCode,
    }
  }

  const terminalListEntry = (term, positions) => {
    const base = {
      id: term.id,
      cwd: term.cwd,
      title: term.title,
      pty: term.pty,
      exited: term.exited,
      exitCode: term.exitCode,
      start: term.startSeq,
      end: term.endSeq,
    }
    if (positions === undefined) return { ...base, snapshot: term.buffer }
    const after = Object.hasOwn(positions, term.id) ? positions[term.id] : undefined
    const { chunk, ...catchup } = readScrollback(term, after ?? 0)
    return { ...base, ...catchup, cwd: term.cwd, title: term.title, pty: term.pty }
  }

  async function openTerminal(body = {}, signal) {
    if (disposed) throw refused('Host is shutting down')
    if (signal?.aborted) throw Object.assign(new Error('Terminal launch cancelled'), { code: 'bot/aborted' })
    if (terminals.size + reservedSlots >= MAX_TERMINALS) {
      throw refused(`Too many open terminals (max ${MAX_TERMINALS})`)
    }
    reservedSlots += 1
    let releaseSpawn
    const spawnDone = new Promise((done) => { releaseSpawn = done })
    inFlightSpawns.add(spawnDone)
    try {
      const cwd = await resolveWorkspaceRoot(body.sessionId)
      if (disposed) throw refused('Host is shutting down')
      if (signal?.aborted) throw Object.assign(new Error('Terminal launch cancelled'), { code: 'bot/aborted' })
      const cols = clampDim(body.cols, 80, 20, 400)
      const rows = clampDim(body.rows, 24, 6, 120)
      const argv = defaultShell()
      const id = `term-${randomUUID().slice(0, 8)}`
      const title = basename(cwd) || cwd

      const subprocess = ctx.get?.('subprocess')
      let record
      let pendingOut = ''
      let pendingStart = 0
      let flushTimer = null
      const clearBatch = () => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
        pendingOut = ''
        pendingStart = 0
      }
      const flush = () => {
        flushTimer = null
        if (record?.closed || pendingOut === '') {
          pendingOut = ''
          return
        }
        const chunk = pendingOut
        const start = pendingStart
        const end = record.endSeq
        const parts = record.parts.filter(part => part.seq >= start && part.seq <= end).map(part => ({ seq: part.seq, text: part.text }))
        pendingOut = ''
        pendingStart = 0
        emitLocal('terminal', { id, chunk, start, end, parts })
        trimScrollback(record)
      }
      const enqueueChunk = (text) => {
        if (!text || !record || record.closed) return
        const before = record.endSeq
        appendScrollback(record, text)
        if (pendingOut === '') pendingStart = before + 1
        pendingOut += text
        if (flushTimer === null) {
          flushTimer = setTimeout(flush, TERMINAL_BATCH_MS)
          flushTimer.unref?.()
        }
      }
      const onExit = (code) => {
        if (!record || record.exited) return
        record.exited = true
        record.exitCode = typeof code === 'number' ? code : null
        if (record.closed) {
          clearBatch()
          return
        }
        if (flushTimer !== null) { clearTimeout(flushTimer); flush() }
        emitLocal('terminal-exit', { id, code: record.exitCode, end: record.endSeq })
      }

      if (typeof subprocess?.spawnTerminal === 'function') {
        const handle = await subprocess.spawnTerminal({
          argv,
          cwd,
          env: ptyEnvOverrides(),
          rows,
          cols,
          terminalType: 'xterm-256color',
          graceMs: TERMINAL_GRACE_MS,
          signal,
        })
        if (disposed || signal?.aborted) {
          await handle.terminate().catch(() => {})
          throw disposed ? refused('Host is shutting down') : Object.assign(new Error('Terminal launch cancelled'), { code: 'bot/aborted' })
        }
        const decoder = new StringDecoder('utf8')
        record = {
          id,
          cwd,
          title,
          pty: true,
          exited: false,
          closed: false,
          exitCode: null,
          buffer: '',
          parts: [],
          startSeq: 1,
          endSeq: 0,
          write: data => handle.write(data),
          resize: (c, r) => handle.resize(c, r),
          terminate: async () => {
            record.closed = true
            clearBatch()
            await handle.terminate().catch(() => {})
          },
        }
        terminals.set(id, record)
        handle.output.on('data', (chunk) => {
          enqueueChunk(typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk)))
        })
        handle.output.on('end', () => {
          const tail = decoder.end()
          if (tail) enqueueChunk(tail)
        })
        handle.output.on('error', () => {
          onExit(null)
        })
        void handle.done.then(outcome => onExit(outcome?.exitCode ?? null), () => onExit(null))
      } else {
        const useProcessGroup = process.platform !== 'win32'
        const child = spawn(argv[0], argv.slice(1), {
          cwd,
          env: fallbackTerminalEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: useProcessGroup,
        })
        const outDecoder = new StringDecoder('utf8')
        const errDecoder = new StringDecoder('utf8')
        let resolveClose
        const closedPromise = new Promise((done) => { resolveClose = done })
        const signalGroup = (sig) => {
          if (useProcessGroup && Number.isInteger(child.pid) && child.pid > 0) {
            try { process.kill(-child.pid, sig); return true } catch { /* fall back to direct child */ }
          }
          try { child.kill(sig); return true } catch { return false }
        }
        record = {
          id,
          cwd,
          title,
          pty: false,
          exited: false,
          closed: false,
          exitCode: null,
          buffer: '',
          parts: [],
          startSeq: 1,
          endSeq: 0,
          write: async (data) => {
            if (record.exited || record.closed) return
            // Non-PTY fallback has no foreground job group, so Ctrl+C cannot interrupt a
            // command without killing the shell itself (UI disables Ctrl+C for non-PTY).
            if (data === '\x03') return
            if (data === '\x04') {
              try { child.stdin?.end() } catch { /* already closed */ }
              return
            }
            if (child.stdin?.destroyed || !child.stdin?.writable) return
            try { child.stdin.write(data) } catch { /* pipe closed */ }
          },
          resize: async () => {},
          terminate: async () => {
            record.closed = true
            clearBatch()
            if (record.exited) return
            signalGroup('SIGTERM')
            let killTimer
            await Promise.race([
              closedPromise,
              new Promise((done) => {
                killTimer = setTimeout(() => {
                  if (!record.exited) signalGroup('SIGKILL')
                  done()
                }, TERMINAL_GRACE_MS)
                killTimer.unref?.()
              }),
            ])
            if (killTimer) clearTimeout(killTimer)
          },
        }
        terminals.set(id, record)
        child.stdin?.on('error', () => { /* suppress EPIPE when child exits mid-write */ })
        child.stdout?.on('data', chunk => enqueueChunk(outDecoder.write(Buffer.from(chunk))))
        child.stderr?.on('data', chunk => enqueueChunk(errDecoder.write(Buffer.from(chunk))))
        child.on('close', (code) => {
          const outTail = outDecoder.end()
          const errTail = errDecoder.end()
          if (outTail) enqueueChunk(outTail)
          if (errTail) enqueueChunk(errTail)
          resolveClose()
          onExit(code)
        })
        child.on('error', (error) => {
          enqueueChunk(`\r\n[terminal error: ${error?.message ?? String(error)}]\r\n`)
          resolveClose()
          onExit(1)
        })
      }

      return { id, cwd, title, cols, rows, pty: record.pty }
    } finally {
      reservedSlots = Math.max(0, reservedSlots - 1)
      inFlightSpawns.delete(spawnDone)
      releaseSpawn()
    }
  }

  async function terminalEndpoint(name, body = {}, signal) {
    if (name === 'list') {
      const positions = body.positions !== null && typeof body.positions === 'object' && !Array.isArray(body.positions) ? body.positions : undefined
      if (positions !== undefined) {
        for (const value of Object.values(positions)) {
          if (!Number.isSafeInteger(value) || value < 0) throw invalid('Terminal positions must be non-negative whole numbers')
        }
      }
      return [...terminals.values()].map(term => terminalListEntry(term, positions))
    }
    if (name === 'open') return openTerminal(body, signal)
    const id = typeof body.id === 'string' ? body.id : ''
    const term = terminals.get(id)
    if (term === undefined) throw notFound('Unknown terminal')
    if (name === 'read') {
      return readScrollback(term, body.after ?? 0)
    }
    if (name === 'input') {
      if (typeof body.data !== 'string') throw invalid('Input data must be a string')
      if (body.data.length > 64 * 1024) throw invalid('Input chunk is too large')
      await term.write(body.data)
      return true
    }
    if (name === 'resize') {
      await term.resize(clampDim(body.cols, 80, 20, 400), clampDim(body.rows, 24, 6, 120))
      return true
    }
    if (name === 'close') {
      terminals.delete(id)
      await term.terminate()
      return true
    }
    throw notFound(`Unknown endpoint terminal-${name}`)
  }

  async function terminalDispose() {
    disposed = true
    const pending = [...inFlightSpawns]
    const active = [...terminals.values()]
    terminals.clear()
    await Promise.all([
      ...active.map(term => term.terminate().catch(() => {})),
      ...pending.map(p => p.catch(() => {})),
    ])
    // Terminate anything that raced into `terminals` just before `disposed` took effect.
    const stragglers = [...terminals.values()]
    terminals.clear()
    if (stragglers.length > 0) {
      await Promise.all(stragglers.map(term => term.terminate().catch(() => {})))
    }
  }

  rt.workspaceEndpoint = workspaceEndpoint
  rt.terminalEndpoint = terminalEndpoint
  rt.terminalDispose = terminalDispose
}
